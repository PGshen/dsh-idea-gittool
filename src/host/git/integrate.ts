// 集成操作（A3 T4，设计 §8.4）：合并、变基、拣选、回滚提交、重置与重置预览。
// - 合并/变基/拣选/回滚（以及 pull/updateProject，见 pull.ts、update.ts）共用 runIntegration：
//   进行中的其他操作 → `git/operation-in-progress`；未提交的已跟踪改动交给 withSmartStash
//   （无 `stash: true` → `git/dirty-worktree`）；停在冲突 → `git/conflict`（operation、conflicts，
//   贮藏随操作保留并记为待恢复：`stashKept`）；无冲突的失败再分 hook / 锁 / 沙箱 / 通用。
// - 不打开编辑器：merge/revert 带 `--no-edit`，写环境另有 `GIT_EDITOR=true`。
// - 用户输入：ref/onto 经 parseRefName 并由 `rev-parse --verify --end-of-options <x>^{commit}` 校验，
//   命令里用 `--end-of-options`；sha 必须是完整十六进制对象名。
// - 合并提交的拣选/回滚需要 `-m`（P1），先读父提交数，> 1 → `git/invalid-payload`（reason 'merge-commit'）。
// - `merge --squash` 成功后结果留在索引、没有进行中的操作：贮藏不弹回（会把结果取消暂存），保留并报 `stashKept`；
//   squash 什么也没带进来（索引与 HEAD 相同）时照常弹回，`committed` 为 true。
// - 拣选/回滚为空（改动已存在）停在操作中：`git/exec-failed` + reason 'empty' + operation，不归咎 hook。
// - 重置：hard 必须 `confirmHard: true`；带 `expectedHead` 时执行前重读 HEAD，对不上 → `git/stale-target`。

import type {
  CommitSummary,
  IntegrateValue,
  ResetMode,
  ResetPreviewValue,
  ResetValue,
  SmartOperationKind,
} from '../../shared/protocol.ts'
import { RESET_PREVIEW_COMMIT_LIMIT } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { resolveCommit } from './branch-write.ts'
import { unmergedCount } from './operation.ts'
import { logArgv, parseCommitSummaries } from './push.ts'
import { dirtyTrackedPaths, dirtyWorktree, stashMessage, withSmartStash } from './smart-stash.ts'
import { detectOperation } from './status.ts'
import {
  OBJECT_ID_PATTERN,
  assertNoOperation,
  hasHook,
  invalidPayload,
  optionalBoolean,
  outputSummary,
  parseRefName,
  payloadRecord,
  queryOk,
  readHead,
  readRunner,
  redactedFailure,
} from './write-support.ts'

const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard']

/**
 * Local hooks each command actually runs (git 2.50 probe, fix round 1): checked only when no
 * conflict explains the failure. None of them runs `pre-commit`.
 */
export const MERGE_HOOKS = ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg'] as const
export const REBASE_HOOKS = ['pre-rebase', 'prepare-commit-msg'] as const
export const PICK_HOOKS = ['prepare-commit-msg'] as const

/** A cherry-pick/revert whose change is already present stops with nothing to commit. */
const EMPTY_PATTERNS: readonly RegExp[] = [/is now empty/i, /nothing to commit/i]

/** git's own refusals a hook never causes (checked before blaming a hook). */
const NOT_A_HOOK_PATTERNS: readonly RegExp[] = [
  /would be overwritten by/i,
  /untracked working tree files/i,
  /unrelated histories/i,
  /not something we can merge/i,
]

/** A full lowercase object name, or `git/invalid-payload`. */
export function parseFullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidPayload(`${label} must be a full lowercase hexadecimal object name`)
  }
  return value
}

/** Before any network access: tracked changes without `stash: true` → `git/dirty-worktree`. */
export async function assertCleanUnlessStash(
  ctx: WriteContext,
  stash: boolean,
  operation: SmartOperationKind,
): Promise<void> {
  if (stash) return
  const dirty = await dirtyTrackedPaths(ctx)
  if (dirty.length > 0) throw dirtyWorktree(dirty, operation)
}

/** One integrate step run under the smart stash. */
export interface IntegrationStep {
  operation: SmartOperationKind
  /** git arguments after the global prefix. */
  args: readonly string[]
  /** Used in messages ("<label> stopped with conflicts"). */
  label: string
  stash: boolean
  /** Extra fields for conflict details (pull: `mode`). */
  details?: Record<string, unknown>
  /** Hooks that could have blocked this command. */
  hooks: readonly string[]
  /** Keep the stash when the step leaves staged changes behind (squash, see the file header). */
  keepStashWhenStaged?: boolean
}

/** Classify a failed step: conflict → hook → lock/sandbox/generic; adds the open operation. */
async function stepFailure(ctx: WriteContext, step: IntegrationStep, result: GitRunResult, stashed: boolean) {
  const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
  const open = operation !== null && operation !== 'bisect' ? { operation } : {}
  const conflicts = await unmergedCount(ctx)
  if (conflicts > 0) {
    const where = stashed
      ? `; your uncommitted changes are kept in the stash ("${stashMessage(step.operation)}")`
      : ''
    return new GitCommandFailure('git/conflict', `${step.label} stopped with conflicts${where}`, {
      ...open,
      conflicts,
      ...step.details,
      stashed,
      output: outputSummary(result),
    })
  }
  const generic = redactedFailure(result, `git ${step.label}`)
  const text = `${result.stderr}\n${result.stdout}`
  if ('operation' in open && EMPTY_PATTERNS.some((pattern) => pattern.test(text))) {
    return new GitCommandFailure('git/exec-failed', `the ${step.label} is empty: skip it or abort`, {
      ...open,
      reason: 'empty',
      output: outputSummary(result),
    })
  }
  const gitRefusal = NOT_A_HOOK_PATTERNS.some((pattern) => pattern.test(text))
  if (
    generic.code !== 'git/locked' &&
    generic.code !== 'git/sandbox-denied' &&
    !gitRefusal &&
    (await hasHook(ctx, step.hooks))
  ) {
    return new GitCommandFailure('git/hook-failed', `the ${step.label} was blocked by a Git hook`, {
      ...open,
      exitCode: result.exitCode,
      output: outputSummary(result),
    })
  }
  return new GitCommandFailure(generic.code, generic.message, { ...generic.details, ...open })
}

/**
 * Run one integrate command under the smart stash (see the file header). `committed` is false
 * when the command left an operation open (e.g. `merge --no-commit`); callers override it for squash.
 */
export async function runIntegration(
  ctx: WriteContext,
  step: IntegrationStep,
): Promise<Omit<IntegrateValue, 'version'>> {
  const { value, outcome } = await withSmartStash(
    ctx,
    {
      stash: step.stash,
      operation: step.operation,
      keepStashOnSuccess: (result: { staged: boolean }) => result.staged,
    },
    async ({ stashed }) => {
      const result = await ctx.git([...GIT_BASE_ARGV, ...step.args])
      if (result.exitCode !== 0) throw await stepFailure(ctx, step, result, stashed)
      const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
      const open = operation !== null && operation !== 'bisect'
      return { open, staged: step.keepStashWhenStaged === true && !open && (await indexDiffersFromHead(ctx)) }
    },
  )
  return { head: (await readHead(ctx)).sha, committed: !value.open && !value.staged, ...outcome }
}

/** Whether the index has changes against HEAD (`diff --cached --quiet`: 0 none, 1 some). */
async function indexDiffersFromHead(ctx: WriteContext): Promise<boolean> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'diff', '--cached', '--quiet', 'HEAD', '--'], { mode: 'read' })
  if (result.exitCode === 0) return false
  if (result.exitCode === 1) return true
  throw redactedFailure(result, 'git diff --cached')
}

function stashFlag(record: Record<string, unknown>): boolean {
  return optionalBoolean(record, 'stash')
}

/** Parents of a commit (validated sha); more than one → `git/invalid-payload` (needs `-m`, P1). */
async function assertNotMergeCommit(ctx: WriteContext, sha: string): Promise<void> {
  await resolveCommit(ctx, sha, 'sha')
  const parents = (await queryOk(ctx, ['log', '-1', '--format=%P', sha, '--'], 'git log')).trim()
  if (parents.split(' ').filter((parent) => parent !== '').length > 1) {
    throw invalidPayload('merge commits need a mainline parent (-m), which is not supported yet', {
      sha,
      reason: 'merge-commit',
    })
  }
}

// --- merge ---------------------------------------------------------------------------

export interface MergeInput {
  ref: string
  noFf: boolean
  squash: boolean
  noCommit: boolean
  stash: boolean
}

export const mergeOperation: WriteOperation<MergeInput, Omit<IntegrateValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const input: MergeInput = {
      ref: parseRefName(record.ref, 'ref'),
      noFf: optionalBoolean(record, 'noFf'),
      squash: optionalBoolean(record, 'squash'),
      noCommit: optionalBoolean(record, 'noCommit'),
      stash: stashFlag(record),
    }
    if (input.squash && input.noFf) throw invalidPayload('squash and noFf cannot be combined')
    return input
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await resolveCommit(ctx, input.ref, 'ref')
    const flags = [
      ...(input.noFf ? ['--no-ff'] : []),
      ...(input.squash ? ['--squash'] : []),
      ...(input.noCommit ? ['--no-commit'] : []),
    ]
    const value = await runIntegration(ctx, {
      operation: 'merge',
      args: ['merge', '--no-edit', ...flags, '--end-of-options', input.ref],
      label: 'merge',
      stash: input.stash,
      hooks: MERGE_HOOKS,
      keepStashWhenStaged: input.squash,
    })
    return value
  },
}

// --- rebase --------------------------------------------------------------------------

export interface RebaseInput {
  onto: string
  stash: boolean
}

export const rebaseOperation: WriteOperation<RebaseInput, Omit<IntegrateValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { onto: parseRefName(record.onto, 'onto'), stash: stashFlag(record) }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await resolveCommit(ctx, input.onto, 'onto')
    return await runIntegration(ctx, {
      operation: 'rebase',
      args: ['rebase', '--end-of-options', input.onto],
      label: 'rebase',
      stash: input.stash,
      hooks: REBASE_HOOKS,
    })
  },
}

// --- cherry-pick / revert ------------------------------------------------------------

export interface CommitPickInput {
  sha: string
  stash: boolean
}

function parseCommitPick(payload: unknown): CommitPickInput {
  const record = payloadRecord(payload)
  return { sha: parseFullSha(record.sha, 'sha'), stash: stashFlag(record) }
}

export const cherryPickOperation: WriteOperation<CommitPickInput, Omit<IntegrateValue, 'version'>> = {
  parse: parseCommitPick,

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await assertNotMergeCommit(ctx, input.sha)
    return await runIntegration(ctx, {
      operation: 'cherry-pick',
      args: ['cherry-pick', '--end-of-options', input.sha],
      label: 'cherry-pick',
      stash: input.stash,
      hooks: PICK_HOOKS,
    })
  },
}

export const revertCommitOperation: WriteOperation<CommitPickInput, Omit<IntegrateValue, 'version'>> = {
  parse: parseCommitPick,

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await assertNotMergeCommit(ctx, input.sha)
    return await runIntegration(ctx, {
      operation: 'revert',
      args: ['revert', '--no-edit', '--end-of-options', input.sha],
      label: 'revert',
      stash: input.stash,
      hooks: PICK_HOOKS,
    })
  },
}

// --- reset ---------------------------------------------------------------------------

export interface ResetInput {
  sha: string
  mode: ResetMode
  expectedHead?: string
}

export const resetOperation: WriteOperation<ResetInput, Omit<ResetValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const mode = record.mode
    if (!RESET_MODES.includes(mode as ResetMode)) throw invalidPayload('mode must be soft, mixed or hard')
    if (mode === 'hard' && record.confirmHard !== true) {
      throw invalidPayload('a hard reset discards changes and needs confirmHard: true')
    }
    if (record.confirmHard !== undefined && typeof record.confirmHard !== 'boolean') {
      throw invalidPayload('confirmHard must be a boolean')
    }
    const input: ResetInput = { sha: parseFullSha(record.sha, 'sha'), mode: mode as ResetMode }
    if (record.expectedHead !== undefined) input.expectedHead = parseFullSha(record.expectedHead, 'expectedHead')
    return input
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await resolveCommit(ctx, input.sha, 'sha')
    if (input.expectedHead !== undefined && (await readHead(ctx)).sha !== input.expectedHead) {
      throw new GitCommandFailure('git/stale-target', 'HEAD moved since the reset was previewed', {
        target: 'head',
        expected: input.expectedHead,
      })
    }
    const result = await ctx.git([...GIT_BASE_ARGV, 'reset', '-q', `--${input.mode}`, input.sha, '--'])
    if (result.exitCode !== 0) throw redactedFailure(result, 'git reset')
    return { head: (await readHead(ctx)).sha }
  },
}

/** Number of tracked paths with uncommitted changes (`status`, untracked excluded). */
function countTrackedChanges(stdout: string): number {
  return stdout.split('\0').filter((record) => record.length >= 4 && record[2] === ' ').length
}

/** `resetPreview` (read): HEAD, tracked changes a hard reset discards, commits it leaves behind. */
export async function readResetPreview(
  run: GitRunner,
  repoRoot: string,
  sha: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<ResetPreviewValue, 'version'>> {
  const git = async (args: readonly string[]): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], { cwd: repoRoot, signal: options.signal })

  const head = await git(['rev-parse', '-q', '--verify', 'HEAD'])
  if (head.exitCode !== 0) throw failureFromExit(head, 'git rev-parse HEAD')
  const target = await git(['rev-parse', '-q', '--verify', '--end-of-options', `${sha}^{commit}`])
  if (target.exitCode !== 0) throw invalidPayload(`unknown sha "${sha}"`, { sha })

  const status = await git([
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=no',
    '--ignore-submodules=none',
  ])
  if (status.exitCode !== 0) throw failureFromExit(status, 'git status')

  const log = await git(logArgv(RESET_PREVIEW_COMMIT_LIMIT + 1, ['HEAD', '--not', sha]))
  if (log.exitCode !== 0) throw failureFromExit(log, 'git log')
  const commits: CommitSummary[] = parseCommitSummaries(log.stdout)
  return {
    head: head.stdout.trim(),
    discardCount: countTrackedChanges(status.stdout),
    commitsLost: commits.slice(0, RESET_PREVIEW_COMMIT_LIMIT),
    truncated: commits.length > RESET_PREVIEW_COMMIT_LIMIT,
  }
}
