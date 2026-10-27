// Shelf (plan b3c, ADR 0011): named, partial "set aside" of uncommitted changes. Each entry is a commit
// object whose tree holds `patch` (`git diff --binary`) and `meta.json`, behind
// `refs/worktree/dsh-git/shelf/<id>`. Everything is written through confined git; the entry is saved
// before the paths are rolled back, so a failed rollback never loses changes.
import type {
  FileStatusCode,
  ShelfApplyValue,
  ShelfCreateValue,
  ShelfDropValue,
  ShelfEntry,
} from '../../shared/protocol.ts'
import { SHELF_REF_PREFIX } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import {
  CLEAN_BATCH_MAX,
  OBJECT_ID_PATTERN,
  assertNoOperation,
  batches,
  invalidPayload,
  optionalBoolean,
  outputSummary,
  parseWritePaths,
  pathspecArgs,
  payloadRecord,
  query,
  readPathStates,
  redactedFailure,
} from './write-support.ts'
import { readHeadPosition } from './smart-stash.ts'

const SHELF_ID_PATTERN = /^[0-9a-z-]{1,64}$/u
const SHELF_NAME_MAX = 200
/** Shelf patches are read whole; generous but bounded. */
const SHELF_PATCH_MAX_BYTES = 16 * 1024 * 1024
/** Fixed identity of the shelf's carrier commit (it is never checked out or pushed). */
const SHELF_IDENTITY = ['-c', 'user.name=dsh-git', '-c', 'user.email=dsh-git@localhost']

export function parseShelfId(value: unknown): string {
  if (typeof value !== 'string' || !SHELF_ID_PATTERN.test(value)) throw invalidPayload('id must be a shelf id', {})
  return value
}

function shelfRef(id: string): string {
  return `${SHELF_REF_PREFIX}${id}`
}

function newShelfId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function parseMeta(id: string, text: string): ShelfEntry | null {
  try {
    const value = JSON.parse(text) as Partial<ShelfEntry>
    if (typeof value.name !== 'string' || typeof value.createdAt !== 'string' || !Array.isArray(value.files)) return null
    return {
      id,
      name: value.name,
      createdAt: value.createdAt,
      branch: typeof value.branch === 'string' ? value.branch : null,
      baseSha: typeof value.baseSha === 'string' ? value.baseSha : '',
      files: value.files.filter((file): file is ShelfEntry['files'][number] => typeof file?.path === 'string'),
    }
  } catch {
    return null
  }
}

/** Shelf entries, newest first; unreadable entries are skipped. */
export async function readShelfList(run: GitRunner, cwd: string, options: { signal?: AbortSignal | undefined } = {}): Promise<ShelfEntry[]> {
  const git = async (args: readonly string[]): Promise<GitRunResult> => await run([...GIT_BASE_ARGV, ...args], { cwd, signal: options.signal })
  const refs = await git(['for-each-ref', '--format=%(refname)', SHELF_REF_PREFIX])
  if (refs.exitCode !== 0) throw failureFromExit(refs, 'git for-each-ref')
  const entries: ShelfEntry[] = []
  for (const ref of refs.stdout.split('\n').filter(line => line !== '')) {
    const id = ref.slice(SHELF_REF_PREFIX.length)
    if (!SHELF_ID_PATTERN.test(id)) continue
    const meta = await git(['cat-file', 'blob', `${ref}:meta.json`])
    const entry = meta.exitCode === 0 ? parseMeta(id, meta.stdout) : null
    if (entry !== null) entries.push(entry)
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The stored patch of one entry. */
export async function readShelfPatch(run: GitRunner, cwd: string, id: string, options: { signal?: AbortSignal | undefined } = {}): Promise<string> {
  const result = await run([...GIT_BASE_ARGV, 'cat-file', 'blob', `${shelfRef(parseShelfId(id))}:patch`], {
    cwd,
    signal: options.signal,
    stdoutMaxBytes: SHELF_PATCH_MAX_BYTES,
  })
  if (result.exitCode !== 0) throw new GitCommandFailure('git/stale-target', 'the shelf entry no longer exists', { target: 'shelf', id })
  return result.stdout
}

function statusOf(state: { x: string; y: string }): FileStatusCode {
  if (state.x === '?') return '?'
  const letter = state.x !== ' ' ? state.x : state.y
  return (['M', 'A', 'D', 'R', 'C', 'T', 'U'].includes(letter) ? letter : 'M') as FileStatusCode
}

async function storeBlob(ctx: WriteContext, content: string): Promise<string> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'hash-object', '-w', '--stdin'], { stdin: content })
  const sha = result.stdout.trim()
  if (result.exitCode !== 0 || !OBJECT_ID_PATTERN.test(sha)) throw redactedFailure(result, 'git hash-object')
  return sha
}

/** `diff --binary` of tracked paths against HEAD plus untracked files as additions. */
async function buildPatch(ctx: WriteContext, tracked: readonly string[], untracked: readonly string[], hasHead: boolean): Promise<string> {
  let patch = ''
  // `diff` has no `--pathspec-from-file`: bounded argv batches like `clean` (A3 T1 spike).
  for (const batch of batches(tracked, CLEAN_BATCH_MAX)) {
    const args = hasHead ? ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--', ...batch] : ['diff', '--binary', '--no-color', '--cached', '--', ...batch]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args], { mode: 'read', stdoutMaxBytes: SHELF_PATCH_MAX_BYTES })
    if (result.exitCode !== 0) throw redactedFailure(result, 'git diff')
    patch += result.stdout
  }
  for (const path of untracked) {
    const result = await ctx.git([...GIT_BASE_ARGV, 'diff', '--binary', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', path], {
      mode: 'read',
      stdoutMaxBytes: SHELF_PATCH_MAX_BYTES,
    })
    // `--no-index` exits 1 when the files differ, which is always the case here.
    if (result.exitCode !== 0 && result.exitCode !== 1) throw redactedFailure(result, 'git diff --no-index')
    patch += result.stdout
  }
  return patch
}

export interface ShelfCreateInput {
  name: string
  paths: string[]
}

export const shelfCreateOperation: WriteOperation<ShelfCreateInput, Omit<ShelfCreateValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '' || name.length > SHELF_NAME_MAX || name.includes('\0')) throw invalidPayload('name must be a non-empty string', {})
    return { name, paths: parseWritePaths(record.paths) }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const states = await readPathStates(ctx, input.paths)
    const chosen = input.paths.filter(path => states.has(path)).sort()
    if (chosen.length === 0) throw invalidPayload('none of the paths has changes to shelve', { reason: 'nothing-to-shelve' })
    const tracked = chosen.filter(path => states.get(path)?.x !== '?')
    const untracked = chosen.filter(path => states.get(path)?.x === '?')
    const head = await readHeadPosition(async (args) => await query(ctx, args))
    const patch = await buildPatch(ctx, tracked, untracked, head.sha !== undefined)
    if (patch.trim() === '') throw invalidPayload('the chosen paths have no textual changes to shelve', { reason: 'nothing-to-shelve' })

    const entry: ShelfEntry = {
      id: newShelfId(),
      name: input.name,
      createdAt: new Date().toISOString(),
      branch: head.branch === null ? null : head.branch.replace(/^refs\/heads\//u, ''),
      baseSha: head.sha ?? '',
      files: chosen.map(path => ({ path, status: statusOf(states.get(path) ?? { x: ' ', y: 'M' }) })),
    }
    const meta = { name: entry.name, createdAt: entry.createdAt, branch: entry.branch, baseSha: entry.baseSha, files: entry.files }
    const patchBlob = await storeBlob(ctx, patch)
    const metaBlob = await storeBlob(ctx, JSON.stringify(meta))
    const tree = await ctx.git([...GIT_BASE_ARGV, 'mktree'], { stdin: `100644 blob ${metaBlob}\tmeta.json\n100644 blob ${patchBlob}\tpatch\n` })
    if (tree.exitCode !== 0) throw redactedFailure(tree, 'git mktree')
    const commit = await ctx.git([...GIT_BASE_ARGV, ...SHELF_IDENTITY, 'commit-tree', tree.stdout.trim(), '-m', 'dsh-git shelf'])
    if (commit.exitCode !== 0) throw redactedFailure(commit, 'git commit-tree')
    const updated = await ctx.git([...GIT_BASE_ARGV, 'update-ref', shelfRef(entry.id), commit.stdout.trim(), ''])
    if (updated.exitCode !== 0) throw redactedFailure(updated, 'git update-ref')

    // Saved: now take the paths back to HEAD (index and worktree), untracked files removed.
    if (tracked.length > 0) {
      const spec = pathspecArgs(tracked)
      const source = head.sha === undefined ? [] : ['--source=HEAD']
      const restored = await ctx.git([...GIT_BASE_ARGV, 'restore', ...source, '--staged', '--worktree', ...spec.args], { stdin: spec.stdin })
      if (restored.exitCode !== 0) throw redactedFailure(restored, 'git restore')
    }
    for (const batch of batches(untracked, CLEAN_BATCH_MAX)) {
      const cleaned = await ctx.git([...GIT_BASE_ARGV, 'clean', '-f', '-q', '--', ...batch])
      if (cleaned.exitCode !== 0) throw redactedFailure(cleaned, 'git clean')
    }
    return { entry }
  },
}

export interface ShelfApplyInput {
  id: string
  keep: boolean
  threeWay: boolean
}

/** Paths a stored patch touches (`apply --numstat -z`; renames give both names). */
async function patchPaths(ctx: WriteContext, patch: string): Promise<string[]> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'apply', '--numstat', '-z'], { mode: 'read', stdin: patch })
  if (result.exitCode !== 0) throw redactedFailure(result, 'git apply --numstat')
  return [...new Set(result.stdout.split('\0').flatMap(token => {
    const fields = token.split('\t')
    return fields.length >= 3 ? [fields[2] ?? ''] : [token]
  }).filter(path => path !== '' && !/^\d+$|^-$/u.test(path)))]
}

async function unmergedPaths(ctx: WriteContext): Promise<string[]> {
  const result = await query(ctx, ['diff', '--name-only', '--diff-filter=U', '-z'])
  return result.exitCode === 0 ? [...new Set(result.stdout.split('\0').filter(path => path !== ''))].sort() : []
}

export const shelfApplyOperation: WriteOperation<ShelfApplyInput, Omit<ShelfApplyValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { id: parseShelfId(record.id), keep: optionalBoolean(record, 'keep'), threeWay: optionalBoolean(record, 'threeWay') }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const patch = await readShelfPatch(async (argv, options) => await ctx.git(argv, { ...options, mode: 'read' }), ctx.repoRoot, input.id)
    let conflicts: string[] = []
    if (input.threeWay) {
      // `apply --3way` refuses files whose working copy differs from the index ("does not match
      // index"); stage the current changes of the touched files first (L4 finding, plan b3c).
      const touched = await patchPaths(ctx, patch)
      const unstaged = (await query(ctx, ['diff', '--name-only', '-z', '--', ...touched])).stdout.split('\0').filter(path => path !== '')
      if (unstaged.length > 0) {
        const spec = pathspecArgs(unstaged)
        const staged = await ctx.git([...GIT_BASE_ARGV, 'add', ...spec.args], { stdin: spec.stdin })
        if (staged.exitCode !== 0) throw redactedFailure(staged, 'git add')
      }
      const merged = await ctx.git([...GIT_BASE_ARGV, 'apply', '--3way'], { stdin: patch })
      conflicts = await unmergedPaths(ctx)
      if (merged.exitCode !== 0 && conflicts.length === 0) {
        const failure = redactedFailure(merged, 'git apply --3way')
        throw new GitCommandFailure(failure.code, failure.message, { ...failure.details, output: outputSummary(merged) })
      }
    } else {
      // Clean application only: a check first, so a refused shelf leaves every file untouched.
      const check = await ctx.git([...GIT_BASE_ARGV, 'apply', '--check'], { stdin: patch })
      if (check.exitCode !== 0) {
        throw new GitCommandFailure('git/conflict', 'the shelf does not apply cleanly onto the current files', {
          reason: 'shelf-not-clean',
          output: outputSummary(check),
        })
      }
      const applied = await ctx.git([...GIT_BASE_ARGV, 'apply'], { stdin: patch })
      if (applied.exitCode !== 0) throw redactedFailure(applied, 'git apply')
    }
    if (!input.keep) {
      const dropped = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '-d', shelfRef(input.id)])
      if (dropped.exitCode !== 0) throw redactedFailure(dropped, 'git update-ref -d')
    }
    return { applied: true, conflicts, kept: input.keep }
  },
}

export const shelfDropOperation: WriteOperation<{ id: string }, Omit<ShelfDropValue, 'version'>> = {
  parse(payload) {
    return { id: parseShelfId(payloadRecord(payload).id) }
  },

  async run(ctx, input) {
    const ref = shelfRef(input.id)
    if ((await query(ctx, ['rev-parse', '-q', '--verify', ref])).exitCode !== 0) {
      throw new GitCommandFailure('git/stale-target', 'the shelf entry no longer exists', { target: 'shelf', id: input.id })
    }
    const dropped = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '-d', ref])
    if (dropped.exitCode !== 0) throw redactedFailure(dropped, 'git update-ref -d')
    return { id: input.id }
  },
}
