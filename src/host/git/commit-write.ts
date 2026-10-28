// 提交写操作（A2 T2，设计 §8.2.4）：只提交勾选文件、仅改信息 Amend、加入 VCS。
// - 只提交勾选文件：`commit --only`，其余暂存内容原样保留（AC2）；路径经 stdin
//   （`--pathspec-from-file=- --pathspec-file-nul`）传入，不受 ARG_MAX 限制（A3 T1，TD-9）；
//   未跟踪路径先 `add -N`，失败时只撤销本次 `add -N` 的路径，索引回到提交前（AC5）。
// - 勾选路径已无改动或已消失 → `git/paths-changed`（status 是几秒前的快照，Agent 可能已改动）。
// - hook 失败 → `git/hook-failed`，details 带脱敏、≤4KB 的输出摘要；永不 `--no-verify`。
// - 合并/变基/拣选/回滚进行中 → `git/operation-in-progress`（操作状态提交在 A3）。

import type { AddToVcsValue, CommitResultValue } from '../../shared/protocol.ts'
import type { GitRunResult, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import {
  assertNoOperationUnlessEditStop,
  hasHook,
  optionalBoolean,
  outputSummary,
  parseCommitMessage,
  parseWritePaths,
  pathspecArgs,
  payloadRecord,
  queryOk,
  readHead,
  readPathStates,
  redactedFailure,
} from './write-support.ts'

export interface CommitFilesInput {
  paths: string[]
  message: string
  amend: boolean
}

export interface AmendMessageInput {
  message: string
}

export interface AddToVcsInput {
  paths: string[]
}

/** Hooks that run during `git commit` and can block it. */
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'] as const

/** git's own "the selected paths do not (or no longer) describe a change" diagnostics. */
const PATHS_CHANGED_PATTERNS: readonly RegExp[] = [
  /pathspec '.*' did not match/i,
  /nothing to commit/i,
  /no changes added to commit/i,
  /nothing added to commit/i,
]

function pathsChanged(message: string, paths: readonly string[]): GitCommandFailure {
  return new GitCommandFailure('git/paths-changed', message, { paths: [...paths] })
}

/**
 * Selected paths plus the other side of any staged rename among them: committing only
 * one side of `git mv` would leave half a rename staged.
 */
async function withRenamePartners(ctx: WriteContext, paths: readonly string[]): Promise<string[]> {
  const stdout = await queryOk(
    ctx,
    ['diff', '--cached', '--name-status', '-z', '-M', '--diff-filter=R', '--no-ext-diff'],
    'git diff --cached',
  )
  const selected = new Set(paths)
  const extra: string[] = []
  const tokens = stdout.split('\0')
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const status = tokens[index] ?? ''
    const from = tokens[index + 1] ?? ''
    const to = tokens[index + 2] ?? ''
    if (!status.startsWith('R')) continue
    if (selected.has(to) && !selected.has(from)) extra.push(from)
    if (selected.has(from) && !selected.has(to)) extra.push(to)
  }
  for (const path of extra) selected.add(path)
  return [...selected]
}

/** git's own failures that a hook can never cause; never report them as a blocked hook (评审 M1). */
const NOT_A_HOOK_PATTERNS: readonly RegExp[] = [
  /Author identity unknown/i,
  /unable to auto-detect email address/i,
  /empty ident name/i,
  /gpg failed to sign/i,
  /failed to write commit object/i,
]

/** Classify a failed `git commit`. */
async function commitFailure(ctx: WriteContext, result: GitRunResult, paths: readonly string[]): Promise<GitCommandFailure> {
  const text = `${result.stderr}\n${result.stdout}`
  const generic = redactedFailure(result, 'git commit')
  if (generic.code === 'git/locked' || generic.code === 'git/sandbox-denied') return generic
  if (PATHS_CHANGED_PATTERNS.some((pattern) => pattern.test(text))) {
    return pathsChanged('the selected files changed since the last refresh', paths)
  }
  if (!NOT_A_HOOK_PATTERNS.some((pattern) => pattern.test(text)) && (await hasHook(ctx, COMMIT_HOOKS))) {
    return new GitCommandFailure('git/hook-failed', 'the commit was blocked by a Git hook', {
      exitCode: result.exitCode,
      output: outputSummary(result),
    })
  }
  return generic
}

async function runCommit(
  ctx: WriteContext,
  args: readonly string[],
  paths: readonly string[],
  stdin?: string,
): Promise<void> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'commit', ...args], stdin === undefined ? {} : { stdin })
  if (result.exitCode !== 0) throw await commitFailure(ctx, result, paths)
}

export const commitFilesOperation: WriteOperation<CommitFilesInput, Omit<CommitResultValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      paths: parseWritePaths(record.paths),
      message: parseCommitMessage(record.message),
      amend: optionalBoolean(record, 'amend'),
    }
  },

  async run(ctx, input) {
    await assertNoOperationUnlessEditStop(ctx)
    const paths = await withRenamePartners(ctx, input.paths)
    const states = await readPathStates(ctx, paths)
    const missing = paths.filter((path) => !states.has(path))
    if (missing.length > 0) {
      throw pathsChanged('some selected files no longer have changes; refresh and retry', missing)
    }
    const untracked = paths.filter((path) => states.get(path)?.x === '?')

    // Paths travel on stdin (A3 T1, TD-9): 2000 long paths exceed ARG_MAX as argv.
    const untrackedSpec = pathspecArgs(untracked)
    if (untracked.length > 0) {
      const added = await ctx.git([...GIT_BASE_ARGV, 'add', '--intent-to-add', ...untrackedSpec.args], {
        stdin: untrackedSpec.stdin,
      })
      if (added.exitCode !== 0) throw redactedFailure(added, 'git add --intent-to-add')
    }
    try {
      const spec = pathspecArgs(paths)
      const args = ['--only', ...(input.amend ? ['--amend'] : []), '-m', input.message, ...spec.args]
      await runCommit(ctx, args, paths, spec.stdin)
    } catch (error) {
      if (untracked.length > 0) {
        // Undo exactly our intent-to-add entries so the index is back to its pre-commit state.
        await ctx
          .git([...GIT_BASE_ARGV, 'reset', '-q', ...untrackedSpec.args], { stdin: untrackedSpec.stdin })
          .catch(() => undefined)
      }
      throw error
    }
    return await readHead(ctx)
  },
}

export const amendMessageOperation: WriteOperation<AmendMessageInput, Omit<CommitResultValue, 'version'>> = {
  parse(payload) {
    return { message: parseCommitMessage(payloadRecord(payload).message) }
  },

  async run(ctx, input) {
    await assertNoOperationUnlessEditStop(ctx)
    const staged = await ctx.git([...GIT_BASE_ARGV, 'diff', '--cached', '--quiet', '--no-ext-diff'], { mode: 'read' })
    if (staged.exitCode === 1) {
      throw new GitCommandFailure(
        'git/index-not-clean',
        'the staging area has changes; amending the message only would include them',
      )
    }
    if (staged.exitCode !== 0) throw redactedFailure(staged, 'git diff --cached')
    // `--only` without paths: the amended commit keeps HEAD's tree, only the message changes.
    await runCommit(ctx, ['--amend', '--only', '-m', input.message], [])
    return await readHead(ctx)
  },
}

export const addToVcsOperation: WriteOperation<AddToVcsInput, Omit<AddToVcsValue, 'version'>> = {
  parse(payload) {
    return { paths: parseWritePaths(payloadRecord(payload).paths) }
  },

  async run(ctx, input) {
    // Only untracked files (评审 M3): staging a tracked change or a whole directory is not "add to VCS".
    const states = await readPathStates(ctx, input.paths)
    const notUntracked = input.paths.filter((path) => states.get(path)?.x !== '?')
    if (notUntracked.length > 0) {
      throw pathsChanged('only untracked files can be added; refresh and retry', notUntracked)
    }
    const spec = pathspecArgs(input.paths)
    const result = await ctx.git([...GIT_BASE_ARGV, 'add', ...spec.args], { stdin: spec.stdin })
    if (result.exitCode !== 0) {
      if (/pathspec '.*' did not match/i.test(result.stderr)) {
        throw pathsChanged('some selected files no longer exist; refresh and retry', input.paths)
      }
      throw redactedFailure(result, 'git add')
    }
    return { added: [...input.paths] }
  },
}
