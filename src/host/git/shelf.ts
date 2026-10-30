// Shelf (plan b3c, ADR 0011): named, partial "set aside" of uncommitted changes.
//
// Each entry is a carrier commit behind `refs/worktree/dsh-git/shelf/<id>` whose tree holds
// `meta.json` and whose objects capture every chosen path exactly: the HEAD entry at shelving time,
// the index entry and the working-tree entry (mode + blob). Index entries are read with `ls-files -s`;
// working-tree files are hashed and written by `hash-object -w`; every blob is an entry of the
// carrier tree so `gc` keeps it. Bytes never pass through JavaScript strings, so encodings, textconv, diff
// prefixes and sizes cannot corrupt an entry (B3c review C2/I1). Restoring goes through the index
// (`update-index --index-info` + `checkout-index`); a three-way unshelve merges each file with
// `merge-file --object-id` (git ≥ 2.43, B4d T5) and records conflicts as index stages 1/2/3.
//
// Order of a shelve: capture → verify the paths did not change meanwhile → write the ref → roll the
// paths back to HEAD. A failure before the ref write leaves everything as it was.
import { lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
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
import { readHeadPosition } from './smart-stash.ts'
import {
  CLEAN_BATCH_MAX,
  OBJECT_ID_PATTERN,
  assertNoOperation,
  batches,
  invalidPayload,
  optionalBoolean,
  parseWritePaths,
  payloadRecord,
  query,
  readPathStates,
  redactedFailure,
  requireGitFeature,
} from './write-support.ts'

const SHELF_ID_PATTERN = /^[0-9a-z-]{1,64}$/u
const SHELF_NAME_MAX = 200
/** The preview diff is for reading only; bounded. */
const SHELF_PREVIEW_MAX_BYTES = 4 * 1024 * 1024
/** Fixed identity of the shelf's carrier commit (it is never checked out or pushed). */
const SHELF_IDENTITY = ['-c', 'user.name=dsh-git', '-c', 'user.email=dsh-git@localhost']
/** Pin the preview's shape regardless of user diff config (review C2). */
const PREVIEW_DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--binary']

/** A mode + blob, or null when the path is absent there. */
interface ObjectEntry {
  mode: string
  oid: string
}

/** What `meta.json` stores per path. */
interface ShelvedFile {
  path: string
  status: FileStatusCode
  head: ObjectEntry | null
  index: ObjectEntry | null
  worktree: ObjectEntry | null
}

interface ShelfMeta {
  name: string
  createdAt: string
  branch: string | null
  baseSha: string
  files: ShelvedFile[]
}

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

function isEntry(value: unknown): value is ObjectEntry | null {
  if (value === null) return true
  const entry = value as Partial<ObjectEntry> | undefined
  return typeof entry?.mode === 'string' && typeof entry.oid === 'string' && OBJECT_ID_PATTERN.test(entry.oid)
}

function parseMeta(text: string): ShelfMeta | null {
  try {
    const value = JSON.parse(text) as Partial<ShelfMeta>
    if (typeof value.name !== 'string' || typeof value.createdAt !== 'string' || !Array.isArray(value.files)) return null
    const files = value.files.filter((file): file is ShelvedFile =>
      typeof file?.path === 'string' && isEntry(file.head) && isEntry(file.index) && isEntry(file.worktree))
    if (files.length !== value.files.length) return null
    return {
      name: value.name,
      createdAt: value.createdAt,
      branch: typeof value.branch === 'string' ? value.branch : null,
      baseSha: typeof value.baseSha === 'string' ? value.baseSha : '',
      files,
    }
  } catch {
    return null
  }
}

function toEntry(id: string, meta: ShelfMeta): ShelfEntry {
  return { id, name: meta.name, createdAt: meta.createdAt, branch: meta.branch, baseSha: meta.baseSha, files: meta.files.map(file => ({ path: file.path, status: file.status })) }
}

type Git = (args: readonly string[], options?: { stdin?: string; stdoutMaxBytes?: number }) => Promise<GitRunResult>

async function readMeta(git: Git, id: string): Promise<ShelfMeta | null> {
  const meta = await git(['cat-file', 'blob', `${shelfRef(id)}:meta.json`])
  return meta.exitCode === 0 ? parseMeta(meta.stdout) : null
}

/** Shelf entries, newest first; unreadable entries are skipped. */
export async function readShelfList(run: GitRunner, cwd: string, options: { signal?: AbortSignal | undefined } = {}): Promise<ShelfEntry[]> {
  const git: Git = async (args) => await run([...GIT_BASE_ARGV, ...args], { cwd, signal: options.signal })
  const refs = await git(['for-each-ref', '--format=%(refname)', SHELF_REF_PREFIX])
  if (refs.exitCode !== 0) throw failureFromExit(refs, 'git for-each-ref')
  const entries: ShelfEntry[] = []
  for (const ref of refs.stdout.split('\n').filter(line => line !== '')) {
    const id = ref.slice(SHELF_REF_PREFIX.length)
    if (!SHELF_ID_PATTERN.test(id)) continue
    const meta = await readMeta(git, id)
    if (meta !== null) entries.push(toEntry(id, meta))
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function emptyBlob(git: Git): Promise<string> {
  const result = await git(['hash-object', '-w', '-t', 'blob', '--stdin'], { stdin: '' })
  const oid = result.stdout.trim()
  if (result.exitCode !== 0 || !OBJECT_ID_PATTERN.test(oid)) throw failureFromExit(result, 'git hash-object')
  return oid
}

/** A readable diff of every shelved file (HEAD at shelving time → shelved worktree). Preview only. */
export async function readShelfPatch(run: GitRunner, cwd: string, id: string, options: { signal?: AbortSignal | undefined } = {}): Promise<string> {
  const git: Git = async (args, extra = {}) => await run([...GIT_BASE_ARGV, ...args], { cwd, signal: options.signal, ...extra })
  const meta = await readMeta(git, parseShelfId(id))
  if (meta === null) throw new GitCommandFailure('git/stale-target', 'the shelf entry no longer exists', { target: 'shelf', id })
  const empty = await emptyBlob(git)
  let text = ''
  for (const file of meta.files) {
    const result = await git(['diff', ...PREVIEW_DIFF_ARGS, file.head?.oid ?? empty, file.worktree?.oid ?? empty], { stdoutMaxBytes: SHELF_PREVIEW_MAX_BYTES })
    const body = result.exitCode === 0 || result.exitCode === 1 ? result.stdout : ''
    text += `# ${file.path}\n${body.replace(/^diff --git a\/[0-9a-f]+ b\/[0-9a-f]+\n/u, '')}`
    if (text.length > SHELF_PREVIEW_MAX_BYTES) break
  }
  return text
}

function statusOf(state: { x: string; y: string }): FileStatusCode {
  if (state.x === '?') return '?'
  const letter = state.x !== ' ' ? state.x : state.y
  return (['M', 'A', 'D', 'R', 'C', 'T', 'U'].includes(letter) ? letter : 'M') as FileStatusCode
}

/** Mode of a gitlink (submodule) entry in a tree or the index. */
const GITLINK_MODE = '160000'

function submoduleRefused(paths: readonly string[]): GitCommandFailure {
  return invalidPayload(`"${paths[0] ?? ''}" is a submodule; submodules cannot be shelved`, { reason: 'submodule', path: paths[0], paths: [...paths] })
}

/**
 * `<mode> <type> <oid>\t<path>` of one path in a tree-ish, or null when absent. A directory there
 * (the path is a new file replacing a tracked directory) is absent as a file; a gitlink is refused
 * explicitly instead of being read as "absent", which would delete it on rollback (plan t2 T3).
 */
async function treeEntry(git: Git, treeish: string, path: string): Promise<ObjectEntry | null> {
  const result = await git(['ls-tree', '-z', '--full-tree', treeish, '--', path])
  if (result.exitCode !== 0) throw failureFromExit(result, 'git ls-tree')
  const [meta = ''] = result.stdout.split('\t')
  const [mode, type, oid] = meta.split(' ')
  if (type === 'commit' || mode === GITLINK_MODE) throw submoduleRefused([path])
  return type === 'blob' && mode !== undefined && oid !== undefined ? { mode, oid } : null
}

/** Stage-0 index entry, or null; an unmerged path and a gitlink are refused. */
async function indexEntry(git: Git, path: string): Promise<ObjectEntry | null> {
  const result = await git(['ls-files', '-s', '-z', '--', path])
  if (result.exitCode !== 0) throw failureFromExit(result, 'git ls-files')
  const records = result.stdout.split('\0').filter(record => record !== '')
  if (records.some(record => !/^\S+ \S+ 0\t/u.test(record))) throw invalidPayload(`"${path}" has unresolved conflicts`, { reason: 'conflict', path })
  const [mode, oid] = (records[0] ?? '').split(/[ \t]/u)
  if (mode === GITLINK_MODE) throw submoduleRefused([path])
  return mode !== undefined && oid !== undefined && records.length > 0 ? { mode, oid } : null
}

/**
 * Requested paths that are submodules: a gitlink in HEAD or the index, or a working-tree directory
 * holding `.git` (a checked-out submodule or an embedded repository). Their content is a commit of
 * another repository, which a shelf cannot capture or restore (plan t2 T3, references mktree/gitlink).
 */
async function findSubmodules(git: Git, root: string, paths: readonly string[]): Promise<string[]> {
  const requested = new Set(paths)
  const found = new Set<string>()
  for (const batch of batches(paths, CLEAN_BATCH_MAX)) {
    const tree = await git(['ls-tree', '-z', '--full-tree', 'HEAD', '--', ...batch])
    if (tree.exitCode !== 0) throw failureFromExit(tree, 'git ls-tree')
    const index = await git(['ls-files', '-s', '-z', '--', ...batch])
    if (index.exitCode !== 0) throw failureFromExit(index, 'git ls-files')
    for (const record of [...tree.stdout.split('\0'), ...index.stdout.split('\0')]) {
      const tab = record.indexOf('\t')
      const path = record.slice(tab + 1)
      if (tab > 0 && record.startsWith(`${GITLINK_MODE} `) && requested.has(path)) found.add(path)
    }
  }
  for (const path of paths) {
    if (found.has(path)) continue
    try {
      if ((await lstat(join(root, path))).isDirectory()) {
        await lstat(join(root, path, '.git'))
        found.add(path)
      }
    } catch {
      // Absent, or a plain directory: not a submodule.
    }
  }
  return paths.filter(path => found.has(path))
}

/** The current working-tree entry, hashed (and written) by git itself; null when absent. */
async function worktreeEntry(git: Git, root: string, path: string, write: boolean): Promise<ObjectEntry | null> {
  let stat
  try {
    stat = await lstat(join(root, path))
  } catch {
    return null
  }
  const flags = write ? ['-w'] : []
  if (stat.isSymbolicLink()) {
    const result = await git(['hash-object', ...flags, '-t', 'blob', '--stdin'], { stdin: await readlink(join(root, path)) })
    if (result.exitCode !== 0) throw failureFromExit(result, 'git hash-object')
    return { mode: '120000', oid: result.stdout.trim() }
  }
  if (!stat.isFile()) return null
  const result = await git(['hash-object', ...flags, '--', path])
  if (result.exitCode !== 0) throw failureFromExit(result, 'git hash-object')
  return { mode: (stat.mode & 0o111) === 0 ? '100644' : '100755', oid: result.stdout.trim() }
}

const same = (a: ObjectEntry | null, b: ObjectEntry | null): boolean => (a === null || b === null ? a === b : a.oid === b.oid)

/** One `update-index --index-info` line: an entry at `stage`, or a removal (mode 0). */
function indexLine(path: string, entry: ObjectEntry | null, zero: string, stage = 0): string {
  return entry === null ? `0 ${zero}\t${path}\n` : `${entry.mode} ${entry.oid} ${String(stage)}\t${path}\n`
}

/** Write `entry` to the working tree via the index (`checkout-index`), or remove the file. */
async function writeWorktree(ctx: WriteContext, path: string, entry: ObjectEntry | null, zero: string): Promise<void> {
  const update = await ctx.git([...GIT_BASE_ARGV, 'update-index', '--index-info'], { stdin: indexLine(path, entry, zero) })
  if (update.exitCode !== 0) throw redactedFailure(update, 'git update-index')
  if (entry !== null) {
    const out = await ctx.git([...GIT_BASE_ARGV, 'checkout-index', '-f', '--', path])
    if (out.exitCode !== 0) throw redactedFailure(out, 'git checkout-index')
    return
  }
  // Not in the index any more: an existing file is untracked now and `clean` removes exactly it.
  const cleaned = await ctx.git([...GIT_BASE_ARGV, 'clean', '-f', '-q', '--', path])
  if (cleaned.exitCode !== 0) throw redactedFailure(cleaned, 'git clean')
}

async function setIndex(ctx: WriteContext, lines: string): Promise<void> {
  if (lines === '') return
  const update = await ctx.git([...GIT_BASE_ARGV, 'update-index', '--index-info'], { stdin: lines })
  if (update.exitCode !== 0) throw redactedFailure(update, 'git update-index')
}

export interface ShelfCreateInput {
  name: string
  paths: string[]
}

function gitOf(ctx: WriteContext): Git {
  return async (args, options = {}) => await ctx.git([...GIT_BASE_ARGV, ...args], { mode: 'read', ...options })
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
    const read = gitOf(ctx)
    const head = await readHeadPosition(async (args) => await query(ctx, args))
    if (head.sha === undefined) throw invalidPayload('shelving needs at least one commit', { reason: 'no-head' })
    // A request naming a submodule is refused as a whole, before anything is captured.
    const submodules = await findSubmodules(read, ctx.repoRoot, input.paths)
    if (submodules.length > 0) throw submoduleRefused(submodules)
    const states = await readPathStates(ctx, input.paths)
    const chosen = input.paths.filter(path => states.has(path)).sort()
    if (chosen.length === 0) throw invalidPayload('none of the paths has changes to shelve', { reason: 'nothing-to-shelve' })

    // 1. Capture, without touching anything: index entries as they are (their blobs exist), the
    // working tree hashed and written by git itself.
    const zero = '0'.repeat(head.sha.length)
    const files: ShelvedFile[] = []
    for (const path of chosen) {
      const status = statusOf(states.get(path) ?? { x: ' ', y: 'M' })
      files.push({
        path,
        status,
        head: await treeEntry(read, 'HEAD', path),
        index: status === '?' ? null : await indexEntry(read, path),
        worktree: await worktreeEntry(read, ctx.repoRoot, path, true),
      })
    }
    const kept = files.flatMap(file => [file.index?.oid, file.worktree?.oid]).filter((oid): oid is string => oid !== undefined)

    // 2. Nothing may have changed since the capture (an Agent editing the same files, review I4).
    for (const file of files) {
      const now = await worktreeEntry(read, ctx.repoRoot, file.path, false)
      const index = file.status === '?' ? null : await indexEntry(read, file.path)
      if (!same(now, file.worktree) || !same(index, file.index)) {
        throw new GitCommandFailure('git/stale-target', `"${file.path}" changed while it was being shelved; nothing was shelved`, { target: 'shelf', path: file.path })
      }
    }

    // 3. Save: meta + every blob reachable from the carrier commit.
    const meta: ShelfMeta = {
      name: input.name,
      createdAt: new Date().toISOString(),
      branch: head.branch === null ? null : head.branch.replace(/^refs\/heads\//u, ''),
      baseSha: head.sha,
      files,
    }
    const metaBlob = await ctx.git([...GIT_BASE_ARGV, 'hash-object', '-w', '--stdin'], { stdin: JSON.stringify(meta) })
    if (metaBlob.exitCode !== 0) throw redactedFailure(metaBlob, 'git hash-object')
    // Every captured blob is an entry of the carrier tree, so `gc` keeps it as long as the ref lives.
    const treeInput = [`100644 blob ${metaBlob.stdout.trim()}\tmeta.json\n`, ...[...new Set(kept)].map((oid, index) => `100644 blob ${oid}\to-${String(index)}\n`)].join('')
    const tree = await ctx.git([...GIT_BASE_ARGV, 'mktree'], { stdin: treeInput })
    if (tree.exitCode !== 0) throw redactedFailure(tree, 'git mktree')
    const commit = await ctx.git([...GIT_BASE_ARGV, ...SHELF_IDENTITY, 'commit-tree', tree.stdout.trim(), '-m', 'dsh-git shelf'])
    if (commit.exitCode !== 0) throw redactedFailure(commit, 'git commit-tree')
    const id = newShelfId()
    const updated = await ctx.git([...GIT_BASE_ARGV, 'update-ref', shelfRef(id), commit.stdout.trim(), ''])
    if (updated.exitCode !== 0) throw redactedFailure(updated, 'git update-ref')

    // 4. Roll the paths back to HEAD (index and working tree; untracked files removed).
    for (const file of files) {
      if (file.status === '?') continue
      await writeWorktree(ctx, file.path, file.head, zero)
    }
    for (const batch of batches(files.filter(file => file.status === '?').map(file => file.path), CLEAN_BATCH_MAX)) {
      const cleaned = await ctx.git([...GIT_BASE_ARGV, 'clean', '-f', '-q', '--', ...batch])
      if (cleaned.exitCode !== 0) throw redactedFailure(cleaned, 'git clean')
    }
    return { entry: toEntry(id, meta) }
  },
}

export interface ShelfApplyInput {
  id: string
  keep: boolean
  threeWay: boolean
}

export const shelfApplyOperation: WriteOperation<ShelfApplyInput, Omit<ShelfApplyValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { id: parseShelfId(record.id), keep: optionalBoolean(record, 'keep'), threeWay: optionalBoolean(record, 'threeWay') }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const read = gitOf(ctx)
    const meta = await readMeta(read, input.id)
    if (meta === null) throw new GitCommandFailure('git/stale-target', 'the shelf entry no longer exists', { target: 'shelf', id: input.id })
    const zero = '0'.repeat(meta.baseSha.length || 40)

    // Clean means: the path is exactly as it was at HEAD when shelved (index and working tree).
    const current = new Map<string, { index: ObjectEntry | null; worktree: ObjectEntry | null }>()
    for (const file of meta.files) {
      // Written (`-w`): a three-way merge reads the current version as "ours".
      current.set(file.path, { index: await indexEntry(read, file.path), worktree: await worktreeEntry(read, ctx.repoRoot, file.path, true) })
    }
    const unclean = meta.files.filter((file) => {
      const now = current.get(file.path)
      return now === undefined || !same(now.index, file.head) || !same(now.worktree, file.head)
    })
    if (unclean.length > 0 && !input.threeWay) {
      throw new GitCommandFailure('git/conflict', 'the shelf does not apply cleanly onto the current files', {
        reason: 'shelf-not-clean',
        paths: unclean.map(file => file.path),
      })
    }

    // Three-way needs `merge-file --object-id`; refuse before any file changes (B4d T5).
    if (unclean.length > 0) await requireGitFeature(ctx, 'mergeFileObjectId')

    const empty = await emptyBlob(read)
    const conflicts: string[] = []
    let finalIndex = ''
    for (const file of meta.files) {
      const now = current.get(file.path) ?? { index: null, worktree: null }
      if (!unclean.includes(file)) {
        await writeWorktree(ctx, file.path, file.worktree, zero)
        finalIndex += indexLine(file.path, file.index, zero)
        continue
      }
      // Three-way per file: ours = current working tree, base = HEAD when shelved, theirs = shelved.
      const merged = await ctx.git([
        ...GIT_BASE_ARGV, 'merge-file', '--object-id', '-L', 'current', '-L', 'base', '-L', 'shelf',
        now.worktree?.oid ?? empty, file.head?.oid ?? empty, file.worktree?.oid ?? empty,
      ])
      const oid = merged.stdout.trim()
      if (merged.exitCode === null || merged.exitCode < 0 || merged.exitCode > 127 || !OBJECT_ID_PATTERN.test(oid)) throw redactedFailure(merged, 'git merge-file')
      const mode = file.worktree?.mode ?? now.worktree?.mode ?? '100644'
      await writeWorktree(ctx, file.path, { mode, oid }, zero)
      if (merged.exitCode === 0) {
        finalIndex += indexLine(file.path, now.index, zero)
        continue
      }
      conflicts.push(file.path)
      finalIndex += `0 ${zero}\t${file.path}\n`
      if (file.head !== null) finalIndex += indexLine(file.path, file.head, zero, 1)
      if (now.worktree !== null) finalIndex += indexLine(file.path, now.worktree, zero, 2)
      if (file.worktree !== null) finalIndex += indexLine(file.path, file.worktree, zero, 3)
    }
    await setIndex(ctx, finalIndex)

    // An entry that left conflicts is always kept (review C1).
    const kept = input.keep || conflicts.length > 0
    if (!kept) {
      const dropped = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '-d', shelfRef(input.id)])
      if (dropped.exitCode !== 0) throw redactedFailure(dropped, 'git update-ref -d')
    }
    return { applied: true, conflicts, kept }
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
