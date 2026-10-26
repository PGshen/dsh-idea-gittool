// Push Rejected 所需的拉取（A2 T3，设计 §11）。完整 Pull/Update Project 在 A3 T4。
// - 先 `fetch` 远程分支到 `refs/remotes/<remote>/<branch>`（网络模式），再按方式 `rebase` 或 `merge`；
// - 只提交勾选文件后工作区通常仍有改动：经智能贮藏（A3 T2 `withSmartStash`，总是贮藏，
//   只含已跟踪改动）在变基/合并后 `stash pop --index` 原样恢复暂存与未暂存（git 的
//   `--autostash` 恢复时会丢掉暂存状态，验收演示问题 1）；恢复冲突时贮藏保留，报 `git/conflict`
//   + `stashKept: true`；
// - 冲突 → `git/conflict`，仓库停在操作状态（不 abort），贮藏记为待恢复，交给操作横幅与冲突流程。

import type { PullForPushMode, PullForPushValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { fetchRemoteBranch, networkFailure } from './push.ts'
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
import { stashMessage, withSmartStash } from './smart-stash.ts'
import { detectOperation } from './status.ts'

export interface PullForPushInput {
  remote: string
  branch: string
  mode: PullForPushMode
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
    // Push Rejected has no "stash and continue" prompt: the pull always stashes (A2 behavior).
    await withSmartStash(ctx, { stash: true, operation: 'pull' }, async ({ stashed }) => {
      const result = await ctx.git([...GIT_BASE_ARGV, ...args])
      if (result.exitCode === 0) return
      const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
      if (operation === 'rebase' || operation === 'merge') {
        // The stash stays until the operation ends; the message tells the user where it is.
        throw new GitCommandFailure(
          'git/conflict',
          stashed
            ? `${input.mode} stopped with conflicts; your uncommitted changes are kept in the stash ("${stashMessage('pull')}")`
            : `${input.mode} stopped with conflicts`,
          { operation, mode: input.mode, stashed, output: outputSummary(result) },
        )
      }
      const generic = redactedFailure(result, `git ${input.mode}`)
      if (generic.code === 'git/locked' || generic.code === 'git/sandbox-denied') throw generic
      if (await hasHook(ctx, PULL_HOOKS)) {
        throw new GitCommandFailure('git/hook-failed', `the ${input.mode} was blocked by a Git hook`, {
          exitCode: result.exitCode,
          output: outputSummary(result),
        })
      }
      throw generic
    })
    return { head: (await readHead(ctx)).sha }
  },
}
