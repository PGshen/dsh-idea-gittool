// Push Rejected 所需的拉取（A2 T3，设计 §11）。完整 Pull/Update Project 在 A3。
// - 先 `fetch` 远程分支到 `refs/remotes/<remote>/<branch>`（网络模式），再按方式 `rebase` 或 `merge`；
// - 只提交勾选文件后工作区通常仍有改动：先自行 `stash push`（只含已跟踪改动，同 autostash），
//   变基/合并后 `stash pop --index` 原样恢复暂存与未暂存（git 的 `--autostash` 恢复时会丢掉暂存
//   状态，验收演示问题 1）；恢复冲突或停在冲突时贮藏保留，结果报 `git/conflict`；
// - 冲突 → `git/conflict`，仓库停在操作状态（不 abort），交给操作横幅与 A3 冲突流程。

import type { PullForPushMode, PullForPushValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { fetchRemoteBranch, networkFailure } from './push.ts'
import type { WriteContext } from '../git-executor.ts'
import {
  assertNoOperation,
  assertPushTarget,
  hasHook,
  invalidPayload,
  outputSummary,
  parseRefName,
  payloadRecord,
  readHead,
  readRunner,
  redactedFailure,
} from './write-support.ts'
import { detectOperation } from './status.ts'

export interface PullForPushInput {
  remote: string
  branch: string
  mode: PullForPushMode
}

const STASH_MESSAGE = 'dsh-git: uncommitted changes before pull'

/** Stash tracked changes (staged and unstaged) when there are any; untracked files stay put. */
async function stashTrackedChanges(ctx: WriteContext): Promise<boolean> {
  const status = await ctx.git(
    [...GIT_BASE_ARGV, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'],
    { mode: 'read' },
  )
  if (status.exitCode !== 0) throw redactedFailure(status, 'git status')
  if (status.stdout.trim() === '') return false
  const stashed = await ctx.git([...GIT_BASE_ARGV, 'stash', 'push', '--quiet', '-m', STASH_MESSAGE])
  if (stashed.exitCode !== 0) throw redactedFailure(stashed, 'git stash push')
  return true
}

/**
 * Put the stashed changes back with the staging area intact. When the exact index cannot be
 * rebuilt, fall back to restoring the content; a conflict keeps the stash and is reported.
 */
async function restoreStash(ctx: WriteContext, mode: PullForPushMode): Promise<void> {
  const exact = await ctx.git([...GIT_BASE_ARGV, 'stash', 'pop', '--index', '--quiet'])
  if (exact.exitCode === 0) return
  const unmerged = await ctx.git([...GIT_BASE_ARGV, 'diff', '--name-only', '--diff-filter=U'], { mode: 'read' })
  if (unmerged.stdout.trim() === '') {
    const contentOnly = await ctx.git([...GIT_BASE_ARGV, 'stash', 'pop', '--quiet'])
    if (contentOnly.exitCode === 0) return
    throw new GitCommandFailure('git/conflict', 'your uncommitted changes conflicted and were kept in the stash', {
      autostash: true,
      mode,
      output: outputSummary(contentOnly),
    })
  }
  throw new GitCommandFailure('git/conflict', 'your uncommitted changes conflicted and were kept in the stash', {
    autostash: true,
    mode,
    output: outputSummary(exact),
  })
}

/** Local hooks that can block a rebase or the merge commit. */
const PULL_HOOKS = ['pre-rebase', 'pre-merge-commit', 'commit-msg'] as const

export const pullForPushOperation: WriteOperation<PullForPushInput, Omit<PullForPushValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const mode = record.mode
    if (mode !== 'rebase' && mode !== 'merge') throw invalidPayload('mode must be "rebase" or "merge"')
    return {
      remote: parseRefName(record.remote, 'remote'),
      branch: parseRefName(record.branch, 'branch'),
      mode,
    }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    await assertPushTarget(ctx, input.remote, input.branch)

    const fetched = await fetchRemoteBranch(ctx, input.remote, input.branch)
    if (fetched.exitCode !== 0) {
      const terminalArgs = ['pull', input.mode === 'rebase' ? '--rebase' : '--no-rebase', input.remote, input.branch]
      throw networkFailure(fetched, ctx.repoRoot, terminalArgs, 'git fetch')
    }

    const upstream = `refs/remotes/${input.remote}/${input.branch}`
    const args = input.mode === 'rebase' ? ['rebase', upstream] : ['merge', '--no-edit', upstream]
    const stashed = await stashTrackedChanges(ctx)
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) {
      const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
      if (operation === 'rebase' || operation === 'merge') {
        // The stash stays until the conflict is resolved; the message tells the user where it is.
        throw new GitCommandFailure(
          'git/conflict',
          stashed
            ? `${input.mode} stopped with conflicts; your uncommitted changes are kept in the stash ("${STASH_MESSAGE}")`
            : `${input.mode} stopped with conflicts`,
          { operation, mode: input.mode, stashed, output: outputSummary(result) },
        )
      }
      // Nothing was applied: put the user's changes back before reporting.
      if (stashed) await restoreStash(ctx, input.mode)
      const generic = redactedFailure(result, `git ${input.mode}`)
      if (generic.code === 'git/locked' || generic.code === 'git/sandbox-denied') throw generic
      if (await hasHook(ctx, PULL_HOOKS)) {
        throw new GitCommandFailure('git/hook-failed', `the ${input.mode} was blocked by a Git hook`, {
          exitCode: result.exitCode,
          output: outputSummary(result),
        })
      }
      throw generic
    }
    if (stashed) await restoreStash(ctx, input.mode)
    return { head: (await readHead(ctx)).sha }
  },
}
