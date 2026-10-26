// 智能贮藏（A3 T2，自 A2 `pull.ts` 抽出）：所有可能停在冲突的操作共用。
// - 有未提交的「已跟踪」改动且请求没带 `stash: true` → `git/dirty-worktree`（未跟踪文件不算、也不贮藏）；
// - `stash: true`：`stash push -m 'dsh-git: before <operation>'`，记下贮藏 sha，执行操作；
//   操作结束后按 sha `stash pop --index`（暂存与未暂存原样恢复），不行就只恢复内容，
//   再不行就保留贮藏并报 `git/conflict` + `stashKept: true`；
// - 操作停在冲突（或成功但仍有操作进行中，如 `--no-commit`）时贮藏保留，并把
//   `{ stashSha, operation, createdAt }` 写进 `<gitDir>/dsh-git/pending-stash.json`；
//   `operationControl`/`operationCommit` 在操作结束后按 sha 恢复并删除标记（Host 重启后仍有效）。
// 贮藏永不丢：任何路径都不 `stash drop`；只有 `pop` 成功才会让贮藏离开列表。

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SmartOperationKind, SmartStashOutcome } from '../../shared/protocol.ts'
import { DIRTY_PATHS_LIMIT } from '../../shared/protocol.ts'
import type { WriteContext } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { outputSummary, queryOk, redactedFailure } from './write-support.ts'
import { detectOperationIn } from './status.ts'

export interface SmartStashOptions {
  /** The request's `stash` flag: true → stash tracked changes first; otherwise refuse them. */
  stash: boolean
  operation: SmartOperationKind
}

export interface SmartStashResult<V> {
  value: V
  outcome: SmartStashOutcome
}

/** Persisted marker of a stash to restore once the stopped operation ends. */
export interface PendingStash {
  stashSha: string
  operation: SmartOperationKind
  /** ISO 8601 timestamp. */
  createdAt: string
}

/** What happened to a pending stash when its operation ended. */
export interface PendingStashOutcome {
  stashRestored?: boolean
  /** The stash is no longer in the list (e.g. dropped by the user); not an error. */
  stashMissing?: boolean
  /** Restoring conflicted; the stash stays in the list. */
  stashKept?: boolean
}

const SMART_OPERATIONS: readonly SmartOperationKind[] = [
  'checkout',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'pull',
  'update',
]

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function stashMessage(operation: SmartOperationKind): string {
  return `dsh-git: before ${operation}`
}

export function pendingStashPath(gitDir: string): string {
  return join(gitDir, 'dsh-git', 'pending-stash.json')
}

/** The pending marker, or undefined when absent or not well-formed (a stash is never inferred). */
export async function readPendingStash(gitDir: string): Promise<PendingStash | undefined> {
  let text: string
  try {
    text = await readFile(pendingStashPath(gitDir), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const { stashSha, operation, createdAt } = record
  if (typeof stashSha !== 'string' || !SHA_PATTERN.test(stashSha)) return undefined
  if (typeof operation !== 'string' || !SMART_OPERATIONS.includes(operation as SmartOperationKind)) return undefined
  return {
    stashSha,
    operation: operation as SmartOperationKind,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
  }
}

async function writePendingStash(gitDir: string, pending: PendingStash): Promise<void> {
  await mkdir(join(gitDir, 'dsh-git'), { recursive: true })
  await writeFile(pendingStashPath(gitDir), `${JSON.stringify(pending)}\n`, 'utf8')
}

async function removePendingStash(gitDir: string): Promise<void> {
  await rm(pendingStashPath(gitDir), { force: true })
}

/** Absolute (per-worktree) git directory of the write context's repository. */
export async function writeGitDir(ctx: WriteContext): Promise<string> {
  return (await queryOk(ctx, ['rev-parse', '--absolute-git-dir'], 'git rev-parse')).trim()
}

/** Tracked paths with uncommitted changes (staged or not); untracked files are ignored. */
export async function dirtyTrackedPaths(ctx: WriteContext): Promise<string[]> {
  const stdout = await queryOk(
    ctx,
    ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no', '--ignore-submodules=none'],
    'git status',
  )
  const paths: string[] = []
  for (const record of stdout.split('\0')) {
    if (record.length < 4 || record[2] !== ' ') continue
    paths.push(record.slice(3))
  }
  return paths
}

/** `git/dirty-worktree` details for a list of changed paths. */
export function dirtyWorktree(paths: readonly string[], operation?: SmartOperationKind): GitCommandFailure {
  return new GitCommandFailure('git/dirty-worktree', 'there are uncommitted changes to tracked files', {
    ...(operation === undefined ? {} : { operation }),
    paths: paths.slice(0, DIRTY_PATHS_LIMIT),
    count: paths.length,
  })
}

async function stashTop(ctx: WriteContext): Promise<string | undefined> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'rev-parse', '-q', '--verify', 'refs/stash'], { mode: 'read' })
  const sha = result.stdout.trim()
  return result.exitCode === 0 && sha !== '' ? sha : undefined
}

/** `stash@{n}` of the stash with this sha right now, or undefined when it is gone. */
async function stashSelector(ctx: WriteContext, sha: string): Promise<string | undefined> {
  const stdout = await queryOk(ctx, ['stash', 'list', '--format=%H'], 'git stash list')
  const index = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '').indexOf(sha)
  return index < 0 ? undefined : `stash@{${String(index)}}`
}

function keptConflict(output: string): GitCommandFailure {
  return new GitCommandFailure('git/conflict', 'your uncommitted changes conflicted and were kept in the stash', {
    stashKept: true,
    output,
  })
}

/**
 * Put a stash back by sha with the staging area intact. When the exact index cannot be
 * rebuilt, fall back to restoring the content; a conflict keeps the stash (`git/conflict`).
 * Returns false when no stash with this sha exists any more.
 */
async function popStash(ctx: WriteContext, sha: string): Promise<boolean> {
  const selector = await stashSelector(ctx, sha)
  if (selector === undefined) return false
  const exact = await ctx.git([...GIT_BASE_ARGV, 'stash', 'pop', '--index', '--quiet', selector])
  if (exact.exitCode === 0) return true
  const unmerged = await ctx.git([...GIT_BASE_ARGV, 'diff', '--name-only', '--diff-filter=U'], { mode: 'read' })
  if (unmerged.stdout.trim() !== '') throw keptConflict(outputSummary(exact))
  // A failed pop keeps the entry; look it up again rather than trusting the old index.
  const again = await stashSelector(ctx, sha)
  if (again === undefined) throw keptConflict(outputSummary(exact))
  const contentOnly = await ctx.git([...GIT_BASE_ARGV, 'stash', 'pop', '--quiet', again])
  if (contentOnly.exitCode === 0) return true
  throw keptConflict(outputSummary(contentOnly))
}

/** Whether an operation (other than bisect) is open in the repository. */
async function operationOpen(gitDir: string): Promise<boolean> {
  const operation = await detectOperationIn(gitDir)
  return operation !== null && operation !== 'bisect'
}

/** Record the stash for later; a marker that cannot be written still leaves the stash in the list. */
async function keepPending(gitDir: string, stashSha: string, operation: SmartOperationKind): Promise<void> {
  try {
    await writePendingStash(gitDir, { stashSha, operation, createdAt: new Date().toISOString() })
  } catch {
    // The stash itself is safe ("dsh-git: before <operation>"); only the automatic restore is lost.
  }
}

function withStashKept(error: unknown): unknown {
  if (!(error instanceof GitCommandFailure)) return error
  return new GitCommandFailure(error.code, error.message, { ...error.details, stashKept: true })
}

/**
 * Run an operation that may stop on conflicts, stashing tracked changes around it
 * (see the file header). `run` must not stash by itself.
 */
export async function withSmartStash<V>(
  ctx: WriteContext,
  options: SmartStashOptions,
  run: (state: { stashed: boolean }) => Promise<V>,
): Promise<SmartStashResult<V>> {
  const dirty = await dirtyTrackedPaths(ctx)
  if (dirty.length === 0) return { value: await run({ stashed: false }), outcome: {} }
  if (!options.stash) throw dirtyWorktree(dirty, options.operation)

  const gitDir = await writeGitDir(ctx)
  const before = await stashTop(ctx)
  const pushed = await ctx.git([...GIT_BASE_ARGV, 'stash', 'push', '--quiet', '-m', stashMessage(options.operation)])
  if (pushed.exitCode !== 0) throw redactedFailure(pushed, 'git stash push')
  const stashSha = await stashTop(ctx)
  if (stashSha === undefined || stashSha === before) {
    // Nothing was stashed after all (changes vanished meanwhile): run as on a clean tree.
    return { value: await run({ stashed: false }), outcome: {} }
  }

  let value: V
  try {
    value = await run({ stashed: true })
  } catch (error) {
    if (await operationOpen(gitDir)) {
      await keepPending(gitDir, stashSha, options.operation)
      throw withStashKept(error)
    }
    // Nothing is in progress: put the user's changes back before reporting.
    await popStash(ctx, stashSha)
    throw error
  }
  if (await operationOpen(gitDir)) {
    await keepPending(gitDir, stashSha, options.operation)
    return { value, outcome: { stashKept: true } }
  }
  await popStash(ctx, stashSha)
  return { value, outcome: { stashRestored: true } }
}

/**
 * Restore the pending stash after its operation ended (continue finished, abort, or
 * merge commit), then delete the marker. No marker → `{}`. The stash is located by sha;
 * gone → `stashMissing`; restore conflict → `stashKept` (the stash stays in the list).
 */
export async function restorePendingStash(ctx: WriteContext): Promise<PendingStashOutcome> {
  const gitDir = await writeGitDir(ctx)
  const pending = await readPendingStash(gitDir)
  if (pending === undefined) return {}
  let outcome: PendingStashOutcome
  try {
    outcome = (await popStash(ctx, pending.stashSha)) ? { stashRestored: true } : { stashMissing: true }
  } catch (error) {
    if (!(error instanceof GitCommandFailure) || error.code !== 'git/conflict') throw error
    outcome = { stashKept: true }
  }
  await removePendingStash(gitDir)
  return outcome
}

/** Whether a well-formed marker exists and its stash (by sha) is still in the list. */
export async function hasPendingStash(gitDir: string, stashShas: readonly string[]): Promise<boolean> {
  const pending = await readPendingStash(gitDir)
  return pending !== undefined && stashShas.includes(pending.stashSha)
}
