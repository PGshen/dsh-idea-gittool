// 操作详情与控制（A3 T2，设计 §10）：合并 / 变基 / 拣选 / 回滚停在冲突后的读取、继续/跳过/中止、合并中提交。
// - `readOperationState`：两侧名字（合并取 MERGE_HEAD + MERGE_MSG，变基取 rebase-*/{head-name,onto}，
//   拣选/回滚取 CHERRY_PICK_HEAD/REVERT_HEAD）、变基进度、冲突与已解决路径、是否有待恢复贮藏；
// - 继续/提交前先看冲突是否清零（否则 `git/conflict` + 数量）；不等编辑器：写环境 `GIT_EDITOR=true`，
//   合并 continue 用 `commit --no-edit`、拣选/回滚 continue 加 `--no-edit`；
// - 操作结束（走完、中止、合并提交）后按 sha 恢复智能贮藏（smart-stash.ts），贮藏永不 drop；
//   只恢复属于这次操作的贮藏：操作种类与分支在执行前核对（评审 M1），对不上就保留并报 `stashKept`。

import type {
  ConflictSide,
  OperationCommitValue,
  OperationControlAction,
  OperationControlValue,
  OperationStateValue,
  RepoOperation,
} from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { cleanupDraftsAfterStep } from './merge-write.ts'
import {
  hasHook,
  invalidPayload,
  outputSummary,
  parseCommitMessage,
  payloadRecord,
  readHead,
  redactedFailure,
} from './write-support.ts'
import type { PendingStash } from './smart-stash.ts'
import {
  finishPendingStash,
  hasPendingStash,
  pendingStashMatches,
  queryOf,
  readPendingStash,
  writeGitDir,
} from './smart-stash.ts'
import {
  detectOperationIn,
  readRebaseStep,
  readStateFile,
  readStatus,
  rebaseStateDir,
  resolveGitDir,
} from './status.ts'
import { join } from 'node:path'

export interface ReadOperationStateOptions {
  signal?: AbortSignal | undefined
}

type Query = (args: readonly string[]) => Promise<GitRunResult>

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** First line of a state file when it is a full object name. */
async function readSha(path: string): Promise<string | undefined> {
  const first = (await readStateFile(path))?.split('\n')[0]?.trim()
  return first !== undefined && SHA_PATTERN.test(first) ? first : undefined
}

async function shortOf(query: Query, sha: string): Promise<string> {
  const result = await query(['rev-parse', '--short', sha])
  const short = result.stdout.trim()
  return result.exitCode === 0 && short !== '' ? short : sha.slice(0, 7)
}

/** A commit known only by its sha: labelled with the short hash. */
async function commitSide(query: Query, sha: string | undefined): Promise<ConflictSide> {
  if (sha === undefined) return { label: '' }
  return { label: await shortOf(query, sha), sha }
}

/** The current branch (or the detached commit). */
async function headSide(query: Query, branch: string | null, head: string | null): Promise<ConflictSide> {
  if (branch !== null) {
    return { label: branch, ref: `refs/heads/${branch}`, ...(head === null ? {} : { sha: head }) }
  }
  return await commitSide(query, head ?? undefined)
}

const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'] as const

function stripRefPrefix(name: string): string {
  for (const prefix of REF_PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length)
  return name
}

/** `MERGE_MSG` without git's `#` comment lines. */
function mergeMessage(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
}

/**
 * The merged side from MERGE_MSG's subject (`Merge branch 'x'`, `Merge remote-tracking branch
 * 'origin/x'`, `Merge tag 'v1'`, `Merge branch 'x' of <url>`); a commit or an octopus merge
 * falls back to the short hash.
 */
async function mergeTheirs(query: Query, subject: string, sha: string | undefined): Promise<ConflictSide> {
  const match = /^Merge (remote-tracking branch|branch|tag) '([^']+)'(.*)$/.exec(subject)
  if (match === null || sha === undefined) return await commitSide(query, sha)
  const kind = match[1] ?? ''
  const name = stripRefPrefix(match[2] ?? '')
  const fromUrl = (match[3] ?? '').startsWith(' of ')
  if (name === '') return await commitSide(query, sha)
  if (fromUrl) return { label: name, sha }
  const prefix = kind === 'tag' ? 'refs/tags/' : kind === 'branch' ? 'refs/heads/' : 'refs/remotes/'
  return { label: name, ref: `${prefix}${name}`, sha }
}

/**
 * The rebase target (`onto`): a branch pointing at it when there is one (local first, never
 * the branch being rebased, no `*\/HEAD`), otherwise the short hash.
 */
async function ontoSide(query: Query, onto: string | undefined, headName: string | undefined): Promise<ConflictSide> {
  if (onto === undefined) return { label: '' }
  const result = await query(['for-each-ref', `--points-at=${onto}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  if (result.exitCode === 0) {
    const refs = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((ref) => ref !== '' && ref !== headName && !ref.endsWith('/HEAD'))
    const ref = refs.find((candidate) => candidate.startsWith('refs/heads/')) ?? refs[0]
    if (ref !== undefined) return { label: stripRefPrefix(ref), ref, sha: onto }
  }
  return await commitSide(query, onto)
}

/** The branch being replayed (`head-name`), with the commit currently being applied. */
async function rebaseTheirs(query: Query, gitDir: string, dir: string, headName: string | undefined): Promise<ConflictSide> {
  const sha = (await readSha(join(gitDir, 'REBASE_HEAD'))) ?? (await readSha(join(dir, 'orig-head')))
  if (headName?.startsWith('refs/heads/') === true) {
    return { label: stripRefPrefix(headName), ref: headName, ...(sha === undefined ? {} : { sha }) }
  }
  return await commitSide(query, sha)
}

/** Staged paths relative to HEAD that are no longer conflicted. */
async function resolvedPaths(query: Query, head: string | null, conflicted: ReadonlySet<string>): Promise<string[]> {
  if (head === null) return []
  const result = await query(['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', 'HEAD'])
  if (result.exitCode !== 0) throw failureFromExit(result, 'git diff --cached')
  const paths = new Set(result.stdout.split('\0').filter((path) => path !== '' && !conflicted.has(path)))
  return [...paths].sort()
}

async function stashShas(query: Query): Promise<string[]> {
  const result = await query(['stash', 'list', '--format=%H'])
  if (result.exitCode !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** `operationState` (read): see {@link OperationStateValue}. */
export async function readOperationState(
  run: GitRunner,
  cwd: string,
  options: ReadOperationStateOptions = {},
): Promise<Omit<OperationStateValue, 'version'>> {
  const query: Query = (args) => run([...GIT_BASE_ARGV, ...args], { cwd, signal: options.signal })
  const gitDir = await resolveGitDir(run, cwd, options.signal)
  if (gitDir === undefined) throw new GitCommandFailure('git/exec-failed', 'could not locate the git directory')
  const status = await readStatus(run, cwd, { signal: options.signal })
  const operation = await detectOperationIn(gitDir)
  const ours = await headSide(query, status.branch, status.head)
  const value: Omit<OperationStateValue, 'version'> = {
    operation,
    ours,
    theirs: { label: '' },
    conflicts: status.conflicts,
    resolved: [],
    pendingStash: await hasPendingStash(query, await stashShas(query)),
  }

  if (operation === 'merge') {
    const raw = (await readStateFile(join(gitDir, 'MERGE_MSG'))) ?? ''
    const message = mergeMessage(raw)
    value.theirs = await mergeTheirs(query, message.split('\n')[0] ?? '', await readSha(join(gitDir, 'MERGE_HEAD')))
    if (message !== '') value.message = message
  } else if (operation === 'rebase') {
    const dir = await rebaseStateDir(gitDir)
    if (dir !== undefined) {
      const headName = await readStateFile(join(dir, 'head-name'))
      value.ours = await ontoSide(query, await readSha(join(dir, 'onto')), headName)
      value.theirs = await rebaseTheirs(query, gitDir, dir, headName)
    }
    const step = await readRebaseStep(gitDir)
    if (step !== undefined) value.step = step
  } else if (operation === 'cherry-pick') {
    value.theirs = await commitSide(query, await readSha(join(gitDir, 'CHERRY_PICK_HEAD')))
  } else if (operation === 'revert') {
    value.theirs = await commitSide(query, await readSha(join(gitDir, 'REVERT_HEAD')))
  }

  if (operation !== null && operation !== 'bisect') {
    value.resolved = await resolvedPaths(query, status.head, new Set(status.conflicts.map((entry) => entry.path)))
  }
  return value
}

// --- writes -----------------------------------------------------------------------

type ControllableOperation = Exclude<RepoOperation, null | 'bisect'>

function isControllable(operation: RepoOperation): operation is ControllableOperation {
  return operation !== null && operation !== 'bisect'
}

async function matchesPending(
  query: Query,
  gitDir: string,
  pending: PendingStash | undefined,
  operation: RepoOperation,
): Promise<boolean> {
  return pending !== undefined && (await pendingStashMatches(query, gitDir, pending, operation))
}

/** Number of unmerged paths right now. */
export async function unmergedCount(ctx: WriteContext): Promise<number> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'diff', '--name-only', '-z', '--diff-filter=U'], { mode: 'read' })
  if (result.exitCode !== 0) throw redactedFailure(result, 'git diff --diff-filter=U')
  return new Set(result.stdout.split('\0').filter((path) => path !== '')).size
}

function conflictsRemain(operation: ControllableOperation, conflicts: number, output?: string): GitCommandFailure {
  return new GitCommandFailure(
    'git/conflict',
    `${operation} has ${String(conflicts)} unresolved conflict${conflicts === 1 ? '' : 's'}`,
    { operation, conflicts, ...(output === undefined ? {} : { output }) },
  )
}

/** Hooks that can block the commit a continue (or merge commit) creates. */
const CONTINUE_HOOKS = ['pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg'] as const

/** git's own failures a hook can never cause (same list as commit-write). */
const NOT_A_HOOK_PATTERNS: readonly RegExp[] = [
  /Author identity unknown/i,
  /unable to auto-detect email address/i,
  /empty ident name/i,
  /gpg failed to sign/i,
  /failed to write commit object/i,
]

async function classifyFailure(ctx: WriteContext, result: GitRunResult, label: string): Promise<GitCommandFailure> {
  const generic = redactedFailure(result, label)
  if (generic.code === 'git/locked' || generic.code === 'git/sandbox-denied') return generic
  const text = `${result.stderr}\n${result.stdout}`
  if (!NOT_A_HOOK_PATTERNS.some((pattern) => pattern.test(text)) && (await hasHook(ctx, CONTINUE_HOOKS))) {
    return new GitCommandFailure('git/hook-failed', `the ${label} was blocked by a Git hook`, {
      exitCode: result.exitCode,
      output: outputSummary(result),
    })
  }
  return generic
}

/** git arguments for one control action (skip already validated). */
function controlArgs(operation: ControllableOperation, action: OperationControlAction): string[] {
  if (operation === 'merge') return action === 'continue' ? ['commit', '--no-edit'] : ['merge', '--abort']
  if (operation === 'rebase') return ['rebase', `--${action}`]
  return action === 'continue' ? [operation, '--continue', '--no-edit'] : [operation, `--${action}`]
}

export interface OperationControlInput {
  action: OperationControlAction
}

export const operationControlOperation: WriteOperation<OperationControlInput, Omit<OperationControlValue, 'version'>> = {
  parse(payload) {
    const action = payloadRecord(payload).action
    if (action !== 'continue' && action !== 'skip' && action !== 'abort') {
      throw invalidPayload('action must be "continue", "skip" or "abort"')
    }
    return { action }
  },

  async run(ctx, input) {
    const gitDir = await writeGitDir(ctx)
    const query = queryOf(ctx)
    const operation = await detectOperationIn(gitDir)
    const pending = await readPendingStash(query)
    if (!isControllable(operation)) {
      // The operation already ended elsewhere (e.g. aborted in a terminal): continue still
      // brings the user's changes back, but only onto the branch they were stashed from.
      if (operation === null && input.action === 'continue' && pending !== undefined) {
        const matches = await pendingStashMatches(query, gitDir, pending, null)
        const outcome = await finishPendingStash(ctx, pending, matches)
        await cleanupDraftsAfterStep(ctx, true)
        return { operation: null, head: (await readHead(ctx)).sha, ...outcome }
      }
      throw invalidPayload('no merge, rebase, cherry-pick or revert is in progress', { operation })
    }
    if (input.action === 'skip' && operation !== 'rebase' && operation !== 'cherry-pick') {
      throw invalidPayload(`skip is not available during a ${operation}`, { operation })
    }
    if (input.action === 'continue') {
      const remaining = await unmergedCount(ctx)
      if (remaining > 0) throw conflictsRemain(operation, remaining)
    }
    // Decided before the action: afterwards the rebase state (head-name) is gone.
    const matches = await matchesPending(query, gitDir, pending, operation)

    const args = controlArgs(operation, input.action)
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    const after = await detectOperationIn(gitDir)
    await cleanupDraftsAfterStep(ctx, !isControllable(after))
    if (isControllable(after)) {
      // Still in progress: stopped on the next conflict, or the step itself failed.
      const remaining = await unmergedCount(ctx)
      if (remaining > 0) throw conflictsRemain(after, remaining, outputSummary(result))
      if (result.exitCode !== 0) throw await classifyFailure(ctx, result, `git ${args.join(' ')}`)
      return { operation: after, head: (await readHead(ctx)).sha }
    }
    // The operation ended: the pending stash goes back whatever the exit code says.
    const outcome = await finishPendingStash(ctx, pending, matches)
    if (result.exitCode !== 0) {
      const failure = await classifyFailure(ctx, result, `git ${args.join(' ')}`)
      throw new GitCommandFailure(failure.code, failure.message, { ...failure.details, ...outcome })
    }
    return { operation: null, head: (await readHead(ctx)).sha, ...outcome }
  },
}

export interface OperationCommitInput {
  message: string
}

export const operationCommitOperation: WriteOperation<OperationCommitInput, Omit<OperationCommitValue, 'version'>> = {
  parse(payload) {
    return { message: parseCommitMessage(payloadRecord(payload).message) }
  },

  async run(ctx, input) {
    const gitDir = await writeGitDir(ctx)
    const operation = await detectOperationIn(gitDir)
    if (operation !== 'merge') {
      throw invalidPayload('operationCommit is only available during a merge', { operation })
    }
    const remaining = await unmergedCount(ctx)
    if (remaining > 0) throw conflictsRemain(operation, remaining)
    const query = queryOf(ctx)
    const pending = await readPendingStash(query)
    const matches = await matchesPending(query, gitDir, pending, operation)
    // Message on stdin, no pathspec: the merge commit takes the whole index.
    const result = await ctx.git([...GIT_BASE_ARGV, 'commit', '-F', '-'], { stdin: input.message })
    if (result.exitCode !== 0) throw await classifyFailure(ctx, result, 'git commit')
    const head = await readHead(ctx)
    await cleanupDraftsAfterStep(ctx, (await detectOperationIn(gitDir)) === null)
    // The commit exists: a failed restore is reported in the value, never as a failed commit (评审 M3).
    const outcome = (await detectOperationIn(gitDir)) === null ? await finishPendingStash(ctx, pending, matches) : {}
    return { ...head, ...outcome }
  },
}
