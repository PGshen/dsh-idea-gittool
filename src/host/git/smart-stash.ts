// 智能贮藏（A3 T2，自 A2 `pull.ts` 抽出）：所有可能停在冲突的操作共用。
// - 有未提交的「已跟踪」改动且请求没带 `stash: true` → `git/dirty-worktree`（未跟踪文件不算、也不贮藏）；
// - `stash: true`：`stash push -m 'dsh-git: before <operation>'`，记下贮藏 sha，执行操作；
//   操作结束后按 sha `stash pop --index`（暂存与未暂存原样恢复），不行就只恢复内容，
//   再不行就保留贮藏并报 `git/conflict` + `stashKept: true`；
// - 操作停在冲突（或成功但仍有操作进行中，如 `--no-commit`）时贮藏保留，并记下待恢复标记：
//   `refs/worktree/dsh-git/pending-stash` → 贮藏提交（顺带让它保持可达），
//   `refs/worktree/dsh-git/pending-stash-meta` → JSON blob `{ operation, branch, headSha, createdAt }`。
//   标记只经受限（confined）的 git 写命令读写（`hash-object -w`、`update-ref --stdin`），Host 进程
//   自己不写 `.git` 下的任何文件（评审 I1：沙箱里的 Agent 可以在 .git 下埋符号链接）；
//   `refs/worktree/` 是每个工作树独立的命名空间，和操作状态文件一致；refs/branches/log 读取都不涉及它。
// - 操作结束后只有「同一种操作 + 同一个分支（变基比 head-name；detached 比 sha）」才自动恢复，
//   否则保留标记并报 `stashKept: true`，由用户在贮藏页显式恢复（评审 M1）。
// 贮藏永不丢：任何路径都不 `stash drop`；只有 `pop` 成功才会让贮藏离开列表。

import { join } from 'node:path'

import type { RepoOperation, SmartOperationKind, SmartStashOutcome } from '../../shared/protocol.ts'
import { DIRTY_PATHS_LIMIT } from '../../shared/protocol.ts'
import type { GitRunResult, WriteContext } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, messageOf } from '../git-executor.ts'
import { outputSummary, queryOk, redactedFailure } from './write-support.ts'
import { detectOperationIn, readStateFile, rebaseStateDir } from './status.ts'

export interface SmartStashOptions<V = unknown> {
  /** The request's `stash` flag: true → stash tracked changes first; otherwise refuse them. */
  stash: boolean
  operation: SmartOperationKind
  /**
   * A3 T4: keep the stash (no marker) after a successful run instead of popping it. For results
   * that leave the index dirty without an open operation (`merge --squash`): `stash pop --index`
   * onto a dirty index fails and its fallback unstages the result (git 2.50 probe). The stash
   * stays in the list as "dsh-git: before <operation>" and the outcome says `stashKept`.
   * Decided from the run's value (fix round 1: a squash that integrated nothing pops normally).
   */
  keepStashOnSuccess?: (value: V) => boolean
}

export interface SmartStashResult<V> {
  value: V
  outcome: SmartStashOutcome
}

/** Per-worktree refs holding the pending stash and its metadata blob. */
export const PENDING_STASH_REF = 'refs/worktree/dsh-git/pending-stash'
export const PENDING_STASH_META_REF = 'refs/worktree/dsh-git/pending-stash-meta'

/** A stash to restore once the stopped operation ends. */
export interface PendingStash {
  stashSha: string
  operation: SmartOperationKind
  /** `refs/heads/<name>` checked out when the stash was made; null when HEAD was detached. */
  branch: string | null
  /** HEAD when the stash was made. */
  headSha: string
  /** ISO 8601 timestamp. */
  createdAt: string
}

/** What happened to a pending stash when its operation ended. */
export interface PendingStashOutcome {
  stashRestored?: boolean
  /** The stash is no longer in the list (e.g. dropped by the user); not an error. */
  stashMissing?: boolean
  /** Not restored (conflict, different operation/branch, or a git failure); the stash stays in the list. */
  stashKept?: boolean
  /** Why restoring failed with an error other than a conflict. */
  stashError?: string
}

/** Read-only git query in the repository (argv without the global prefix). */
export type GitQuery = (args: readonly string[]) => Promise<GitRunResult>

export function queryOf(ctx: WriteContext): GitQuery {
  return (args) => ctx.git([...GIT_BASE_ARGV, ...args], { mode: 'read' })
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

async function resolveRef(query: GitQuery, ref: string): Promise<string | undefined> {
  const result = await query(['rev-parse', '-q', '--verify', ref])
  const sha = result.stdout.trim()
  return result.exitCode === 0 && SHA_PATTERN.test(sha) ? sha : undefined
}

/** The pending marker, or undefined when absent or not well-formed (a stash is never inferred). */
export async function readPendingStash(query: GitQuery): Promise<PendingStash | undefined> {
  const stashSha = await resolveRef(query, PENDING_STASH_REF)
  if (stashSha === undefined) return undefined
  const meta = await query(['cat-file', 'blob', PENDING_STASH_META_REF])
  if (meta.exitCode !== 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(meta.stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { operation, branch, headSha, createdAt } = parsed as Record<string, unknown>
  if (typeof operation !== 'string' || !SMART_OPERATIONS.includes(operation as SmartOperationKind)) return undefined
  if (branch !== null && (typeof branch !== 'string' || !branch.startsWith('refs/heads/'))) return undefined
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) return undefined
  return {
    stashSha,
    operation: operation as SmartOperationKind,
    branch,
    headSha,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
  }
}

/** HEAD as `{ branch, sha }`; branch is null when detached. */
export async function readHeadPosition(query: GitQuery): Promise<{ branch: string | null; sha: string | undefined }> {
  const symbolic = await query(['symbolic-ref', '-q', 'HEAD'])
  const branch = symbolic.exitCode === 0 && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : null
  return { branch, sha: await resolveRef(query, 'HEAD') }
}

/** Write both marker refs in one confined transaction. */
async function writePendingStash(ctx: WriteContext, pending: PendingStash): Promise<void> {
  const meta = JSON.stringify({
    operation: pending.operation,
    branch: pending.branch,
    headSha: pending.headSha,
    createdAt: pending.createdAt,
  })
  const blob = await ctx.git([...GIT_BASE_ARGV, 'hash-object', '-w', '--stdin'], { stdin: meta })
  const blobSha = blob.stdout.trim()
  if (blob.exitCode !== 0 || !SHA_PATTERN.test(blobSha)) throw redactedFailure(blob, 'git hash-object')
  const updated = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '--stdin'], {
    stdin: `update ${PENDING_STASH_REF} ${pending.stashSha}\nupdate ${PENDING_STASH_META_REF} ${blobSha}\n`,
  })
  if (updated.exitCode !== 0) throw redactedFailure(updated, 'git update-ref')
}

/** Delete both marker refs (confined); a failure leaves a marker that the sha check neutralizes. */
async function removePendingStash(ctx: WriteContext): Promise<void> {
  await ctx
    .git([...GIT_BASE_ARGV, 'update-ref', '--stdin'], {
      stdin: `delete ${PENDING_STASH_REF}\ndelete ${PENDING_STASH_META_REF}\n`,
    })
    .catch(() => undefined)
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
async function keepPending(
  ctx: WriteContext,
  stashSha: string,
  operation: SmartOperationKind,
  head: { branch: string | null; sha: string | undefined },
): Promise<void> {
  if (head.sha === undefined) return
  try {
    await writePendingStash(ctx, {
      stashSha,
      operation,
      branch: head.branch,
      headSha: head.sha,
      createdAt: new Date().toISOString(),
    })
  } catch {
    // The stash itself is safe ("dsh-git: before <operation>"); only the automatic restore is lost.
  }
}

function withDetails(error: unknown, details: object): unknown {
  if (!(error instanceof GitCommandFailure)) return error
  return new GitCommandFailure(error.code, error.message, { ...error.details, ...details })
}

/**
 * Run an operation that may stop on conflicts, stashing tracked changes around it
 * (see the file header). `run` must not stash by itself.
 */
export async function withSmartStash<V>(
  ctx: WriteContext,
  options: SmartStashOptions<V>,
  run: (state: { stashed: boolean }) => Promise<V>,
): Promise<SmartStashResult<V>> {
  const dirty = await dirtyTrackedPaths(ctx)
  if (dirty.length === 0) return { value: await run({ stashed: false }), outcome: {} }
  if (!options.stash) throw dirtyWorktree(dirty, options.operation)

  const gitDir = await writeGitDir(ctx)
  const head = await readHeadPosition(queryOf(ctx))
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
      await keepPending(ctx, stashSha, options.operation, head)
      throw withDetails(error, { stashKept: true })
    }
    // Nothing is in progress: put the user's changes back, then report the original failure (评审 M2).
    let outcome: PendingStashOutcome
    try {
      outcome = (await popStash(ctx, stashSha)) ? { stashRestored: true } : { stashMissing: true }
    } catch (restoreError) {
      outcome = { stashKept: true, ...(isConflict(restoreError) ? {} : { stashError: messageOf(restoreError) }) }
    }
    throw withDetails(error, outcome)
  }
  if (await operationOpen(gitDir)) {
    await keepPending(ctx, stashSha, options.operation, head)
    return { value, outcome: { stashKept: true } }
  }
  if (options.keepStashOnSuccess?.(value) === true) return { value, outcome: { stashKept: true } }
  // The stash may have been dropped meanwhile (e.g. by the Agent): report it, never claim a restore.
  const restored = await popStash(ctx, stashSha)
  return { value, outcome: restored ? { stashRestored: true } : { stashMissing: true } }
}

function isConflict(error: unknown): boolean {
  return error instanceof GitCommandFailure && error.code === 'git/conflict'
}

/** Repository operations a smart operation of each kind can leave open. */
const OPEN_OPERATIONS: Readonly<Record<SmartOperationKind, readonly RepoOperation[]>> = {
  checkout: [],
  merge: ['merge'],
  rebase: ['rebase'],
  'cherry-pick': ['cherry-pick'],
  revert: ['revert'],
  pull: ['merge', 'rebase'],
  update: ['merge', 'rebase'],
}

/**
 * Whether `pending` belongs to the operation about to end (评审 M1): call it **before**
 * continue/abort/commit. `operation` null (the operation already ended elsewhere) checks
 * the branch only. A rebase compares its `head-name` (HEAD is detached meanwhile);
 * a stash made on a detached HEAD compares shas.
 */
export async function pendingStashMatches(
  query: GitQuery,
  gitDir: string,
  pending: PendingStash,
  operation: RepoOperation,
): Promise<boolean> {
  if (operation !== null && !OPEN_OPERATIONS[pending.operation].includes(operation)) return false
  if (operation === 'rebase') {
    const dir = await rebaseStateDir(gitDir)
    if (dir === undefined) return false
    if (pending.branch !== null) return (await readStateFile(join(dir, 'head-name'))) === pending.branch
    return (await readStateFile(join(dir, 'orig-head'))) === pending.headSha
  }
  const head = await readHeadPosition(query)
  return pending.branch !== null ? head.branch === pending.branch : head.sha === pending.headSha
}

/**
 * Finish a pending stash after its operation ended (never throws): not matching → kept
 * with the marker in place; otherwise popped by sha and the marker deleted. Gone →
 * `stashMissing`; conflict → `stashKept` (the stash stays in the list); any other failure →
 * `stashKept` + `stashError`, marker kept.
 */
export async function finishPendingStash(
  ctx: WriteContext,
  pending: PendingStash | undefined,
  matches: boolean,
): Promise<PendingStashOutcome> {
  if (pending === undefined) return {}
  if (!matches) return { stashKept: true }
  try {
    const restored = await popStash(ctx, pending.stashSha)
    await removePendingStash(ctx)
    return restored ? { stashRestored: true } : { stashMissing: true }
  } catch (error) {
    if (isConflict(error)) {
      await removePendingStash(ctx)
      return { stashKept: true }
    }
    return { stashKept: true, stashError: messageOf(error) }
  }
}

/** Read, match against the current HEAD (no operation open) and finish the pending stash. */
export async function restorePendingStash(ctx: WriteContext): Promise<PendingStashOutcome> {
  const query = queryOf(ctx)
  const pending = await readPendingStash(query)
  if (pending === undefined) return {}
  const matches = await pendingStashMatches(query, await writeGitDir(ctx), pending, null)
  return await finishPendingStash(ctx, pending, matches)
}

/** Whether a well-formed marker exists and its stash (by sha) is still in the list. */
export async function hasPendingStash(query: GitQuery, stashShas: readonly string[]): Promise<boolean> {
  const pending = await readPendingStash(query)
  return pending !== undefined && stashShas.includes(pending.stashSha)
}
