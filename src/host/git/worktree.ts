// Worktrees (plan b3d T3, behind the client flag `worktrees`): list, add from an existing or a new
// branch at a path inside the repository (the write boundary of `workspace-write`), remove, prune.
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { WorktreeAddValue, WorktreeEntry, WorktreePruneValue, WorktreeRemoveValue } from '../../shared/protocol.ts'
import type { GitCommandFailure, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { isWithinRoot } from '../sandbox-gate.ts'
import { validateRepoPath } from './diff.ts'
import { invalidPayload, optionalBoolean, outputSummary, parseRefName, payloadRecord, query, readRunner, redactedFailure } from './write-support.ts'

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** `worktree list --porcelain`, with `current` marking the worktree of `cwd`. */
export async function readWorktreeList(run: GitRunner, cwd: string, options: { signal?: AbortSignal | undefined } = {}): Promise<WorktreeEntry[]> {
  const listed = await run([...GIT_BASE_ARGV, 'worktree', 'list', '--porcelain'], { cwd, signal: options.signal })
  if (listed.exitCode !== 0) throw failureFromExit(listed, 'git worktree list')
  const top = await run([...GIT_BASE_ARGV, 'rev-parse', '--show-toplevel'], { cwd, signal: options.signal })
  const here = await canonical(top.exitCode === 0 ? top.stdout.trim() : cwd)
  const entries: WorktreeEntry[] = []
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n').filter(line => line !== '')
    const pathLine = lines.find(line => line.startsWith('worktree '))
    if (pathLine === undefined) continue
    const path = await canonical(pathLine.slice('worktree '.length))
    const branchLine = lines.find(line => line.startsWith('branch '))
    entries.push({
      path,
      head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? null,
      branch: branchLine === undefined ? null : branchLine.slice('branch '.length).replace(/^refs\/heads\//u, ''),
      current: path === here,
      locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
      prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')),
      bare: lines.includes('bare'),
      // `worktree list` always prints the main worktree first.
      main: entries.length === 0,
    })
  }
  return entries
}

async function listOf(ctx: WriteContext): Promise<WorktreeEntry[]> {
  return await readWorktreeList(readRunner(ctx), ctx.repoRoot)
}

export interface WorktreeAddInput {
  path: string
  branch: string
  createBranch: boolean
  startPoint: string | undefined
}

/**
 * Keep a worktree created inside the repository out of the main worktree's untracked files: otherwise
 * `git add` on it stages an embedded-repository gitlink. Uses `info/exclude`, which is local and never
 * committed (the user's `.gitignore` stays untouched). Skipped when the exclude file lies outside the
 * repository (a linked-worktree session whose common dir is elsewhere).
 */
async function excludeLocally(ctx: WriteContext, path: string): Promise<void> {
  const located = await query(ctx, ['rev-parse', '--git-path', 'info/exclude'])
  const named = located.stdout.trim()
  if (located.exitCode !== 0 || named === '') return
  const file = isAbsolute(named) ? named : join(ctx.repoRoot, named)
  const [root, gitDir] = await Promise.all([realpath(ctx.repoRoot), realpath(dirname(dirname(file))).catch(() => null)])
  if (gitDir === null) return
  const inside = relative(root, gitDir)
  if (inside.startsWith('..') || isAbsolute(inside)) return
  await mkdir(dirname(file), { recursive: true })
  const line = `/${path.replace(/\/+$/u, '').replace(/[*?[\\]/gu, match => `\\${match}`)}/`
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split('\n').includes(line)) return
  await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`)
}

function outsideRepository(): GitCommandFailure {
  return invalidPayload('worktree path leaves the repository', { reason: 'path-outside-repository' })
}

/**
 * T2 T4: `validateRepoPath` only checks the path literally; a symlinked segment (`.worktrees ->
 * /outside`) would still lead `git worktree add` out of the repository. Resolve the deepest existing
 * ancestor (the target itself counts: git accepts an existing empty directory, but never a symlink
 * there), require its real path inside the real repository root (the root itself may be reached
 * through a symlink, e.g. macOS /tmp), and hand git the resolved path so it never follows a link.
 * Residual TOCTOU risk: a symlink created between this check and git's mkdir is not caught here; the
 * sandbox confiner (`workspace-write`) stays the backstop, and the post-add check reports it.
 */
export async function resolveInsideRepository(repoRoot: string, path: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const root = await realpath(repoRoot)
  // Review I2: split like `validateRepoPath`, which accepts `\\` as a separator on Windows.
  const segments = path.split(platform === 'win32' ? /[\\/]/u : '/').filter(segment => segment !== '' && segment !== '.')
  for (let depth = segments.length; depth >= 0; depth--) {
    const candidate = join(repoRoot, ...segments.slice(0, depth))
    let info
    try {
      info = await lstat(candidate)
    } catch {
      continue
    }
    if (depth === segments.length && info.isSymbolicLink()) throw outsideRepository()
    const resolved = await realpath(candidate).catch(() => null)
    if (resolved === null || !isWithinRoot(root, resolved)) throw outsideRepository()
    return join(resolved, ...segments.slice(depth))
  }
  throw outsideRepository()
}

export const worktreeAddOperation: WriteOperation<WorktreeAddInput, Omit<WorktreeAddValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      path: validateRepoPath(record.path),
      branch: parseRefName(record.branch, 'branch'),
      createBranch: optionalBoolean(record, 'createBranch'),
      startPoint: record.startPoint === undefined ? undefined : parseRefName(record.startPoint, 'startPoint'),
    }
  },

  async run(ctx, input) {
    const target = await resolveInsideRepository(ctx.repoRoot, input.path)
    const ref = `refs/heads/${input.branch}`
    if ((await query(ctx, ['check-ref-format', ref])).exitCode !== 0) throw invalidPayload(`invalid branch name "${input.branch}"`, {})
    const exists = (await query(ctx, ['rev-parse', '-q', '--verify', ref])).exitCode === 0
    if (input.createBranch && exists) throw invalidPayload(`branch "${input.branch}" already exists`, { reason: 'branch-exists' })
    if (!input.createBranch && !exists) throw invalidPayload(`branch "${input.branch}" does not exist`, { reason: 'no-branch' })
    const args = input.createBranch
      ? ['worktree', 'add', '-b', input.branch, '--', target, input.startPoint ?? 'HEAD']
      : ['worktree', 'add', '--', target, input.branch]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) {
      if (/already (checked out|used by worktree)/iu.test(result.stderr)) {
        throw invalidPayload(`branch "${input.branch}" is checked out in another worktree`, { reason: 'branch-checked-out', output: outputSummary(result) })
      }
      throw redactedFailure(result, 'git worktree add')
    }
    // Review M3: exclude where the worktree really is (`.worktrees` may link elsewhere in the repository).
    await excludeLocally(ctx, relative(await realpath(ctx.repoRoot), target).split(sep).join('/'))
    const path = await canonical(target)
    const worktree = (await listOf(ctx)).find(entry => entry.path === path)
    if (worktree === undefined) throw invalidPayload('the new worktree is not listed', {})
    // Double check after the fact (a symlink swapped in between the check and git). The worktree is
    // reported, not deleted: removing what git just created elsewhere is riskier than leaving it.
    if (!isWithinRoot(await realpath(ctx.repoRoot), worktree.path)) throw outsideRepository()
    return { worktree }
  },
}

export const worktreeRemoveOperation: WriteOperation<{ path: string; force: boolean }, Omit<WorktreeRemoveValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.path !== 'string' || record.path === '' || record.path.includes('\0')) throw invalidPayload('path must be a worktree path', {})
    return { path: record.path, force: optionalBoolean(record, 'force') }
  },

  async run(ctx, input) {
    const path = await canonical(input.path)
    const entry = (await listOf(ctx)).find(candidate => candidate.path === path)
    if (entry === undefined) throw invalidPayload('not a worktree of this repository', { reason: 'not-a-worktree' })
    if (entry.current || entry.bare) throw invalidPayload('the current worktree cannot be removed', { reason: 'current-worktree' })
    if (entry.main) throw invalidPayload('the main worktree cannot be removed', { reason: 'main-worktree' })
    // `--force` once does not override a lock; refuse explicitly so the client can say why.
    if (entry.locked) throw invalidPayload('the worktree is locked', { reason: 'worktree-locked' })
    const result = await ctx.git([...GIT_BASE_ARGV, 'worktree', 'remove', ...(input.force ? ['--force'] : []), '--', entry.path])
    if (result.exitCode !== 0) {
      if (/contains modified or untracked files|is dirty/iu.test(result.stderr)) {
        throw invalidPayload('the worktree has uncommitted changes', { reason: 'worktree-dirty', output: outputSummary(result) })
      }
      throw redactedFailure(result, 'git worktree remove')
    }
    return { path: entry.path }
  },
}

export const worktreePruneOperation: WriteOperation<Record<string, never>, Omit<WorktreePruneValue, 'version'>> = {
  parse() {
    return {}
  },

  async run(ctx) {
    const before = (await listOf(ctx)).filter(entry => entry.prunable).length
    const result = await ctx.git([...GIT_BASE_ARGV, 'worktree', 'prune'])
    if (result.exitCode !== 0) throw redactedFailure(result, 'git worktree prune')
    const after = (await listOf(ctx)).filter(entry => entry.prunable).length
    return { pruned: before - after }
  },
}
