// Push Rejected 所需的拉取（A2 T3，设计 §11）。完整 Pull/Update Project 在 A3。
// - 先 `fetch` 远程分支到 `refs/remotes/<remote>/<branch>`（网络模式），再按方式 `rebase` 或 `merge`；
// - 带 `--autostash`：只提交勾选文件后工作区通常仍有改动，变基/合并不能因此失败；
// - 冲突 → `git/conflict`，仓库停在操作状态（不 abort），交给操作横幅与 A3 冲突流程。

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
    const args =
      input.mode === 'rebase'
        ? ['rebase', '--autostash', upstream]
        : ['merge', '--no-edit', '--autostash', upstream]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) {
      const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
      if (operation === 'rebase' || operation === 'merge') {
        throw new GitCommandFailure('git/conflict', `${input.mode} stopped with conflicts`, {
          operation,
          mode: input.mode,
          output: outputSummary(result),
        })
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
    }
    return { head: (await readHead(ctx)).sha }
  },
}
