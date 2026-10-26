// 拉取（A2 T3 Push Rejected 的 pullForPush；A3 T4 起完整 `pull` 与它共用实现，设计 §11）。
// - 先 `fetch` 远程分支到 `refs/remotes/<remote>/<branch>`（网络模式），再按方式 `rebase` 或 `merge`；
//   `pull` 不带 `stash: true` 时在联网前就检查已跟踪改动（`git/dirty-worktree`，operation 'pull'）；
// - 变基/合并经 integrate.ts 的 runIntegration（智能贮藏：只含已跟踪改动，之后 `stash pop --index`
//   原样恢复暂存与未暂存——git 的 `--autostash` 恢复时会丢掉暂存状态，验收演示问题 1）；恢复冲突时
//   贮藏保留，报 `git/conflict` + `stashKept: true`；
// - 冲突 → `git/conflict`，仓库停在操作状态（不 abort），贮藏记为待恢复，交给操作横幅与冲突流程；
// - `pullForPush`（A2 客户端）不变：总是贮藏，返回 `{ head }`。

import type { IntegrateValue, PullForPushValue, PullMode } from '../../shared/protocol.ts'
import type { WriteContext, WriteOperation } from '../git-executor.ts'
import { assertCleanUnlessStash, runIntegration } from './integrate.ts'
import { fetchRemoteBranch, networkFailure } from './push.ts'
import {
  assertNoOperation,
  assertPushTarget,
  invalidPayload,
  optionalBoolean,
  parseRefName,
  payloadRecord,
} from './write-support.ts'

export interface PullInput {
  remote: string
  branch: string
  mode: PullMode
  stash: boolean
}

function parsePull(payload: unknown, stash: (record: Record<string, unknown>) => boolean): PullInput {
  const record = payloadRecord(payload)
  const mode = record.mode
  if (mode !== 'rebase' && mode !== 'merge') throw invalidPayload('mode must be "rebase" or "merge"')
  return {
    remote: parseRefName(record.remote, 'remote'),
    branch: parseRefName(record.branch, 'branch'),
    mode,
    stash: stash(record),
  }
}

/** fetch the remote branch, then rebase onto / merge its remote-tracking ref (shared by pull and pullForPush). */
export async function runPull(ctx: WriteContext, input: PullInput): Promise<Omit<IntegrateValue, 'version'>> {
  await assertNoOperation(ctx)
  await assertPushTarget(ctx, input.remote, input.branch)
  await assertCleanUnlessStash(ctx, input.stash, 'pull')

  const fetched = await fetchRemoteBranch(ctx, input.remote, input.branch)
  if (fetched.exitCode !== 0) {
    const terminalArgs = ['pull', input.mode === 'rebase' ? '--rebase' : '--no-rebase', input.remote, input.branch]
    throw networkFailure(fetched, ctx.repoRoot, terminalArgs, 'git fetch')
  }

  const upstream = `refs/remotes/${input.remote}/${input.branch}`
  return await runIntegration(ctx, {
    operation: 'pull',
    args: input.mode === 'rebase' ? ['rebase', upstream] : ['merge', '--no-edit', upstream],
    label: input.mode,
    stash: input.stash,
    details: { mode: input.mode },
  })
}

export const pullOperation: WriteOperation<PullInput, Omit<IntegrateValue, 'version'>> = {
  parse: (payload) => parsePull(payload, (record) => optionalBoolean(record, 'stash')),
  run: runPull,
}

/** A2 alias: Push Rejected has no "stash and continue" prompt, so it always stashes. */
export const pullForPushOperation: WriteOperation<PullInput, Omit<PullForPushValue, 'version'>> = {
  parse: (payload) => parsePull(payload, () => true),
  async run(ctx, input) {
    return { head: (await runPull(ctx, input)).head }
  },
}
