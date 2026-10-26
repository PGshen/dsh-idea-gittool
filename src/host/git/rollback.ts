// 回滚写操作（A2 T2，设计 §8.2.5）：
// - 已跟踪路径只丢弃工作区改动（`restore --worktree`，路径经 stdin），暂存内容保留并在 `keptStaged` 里列出；
// - 未跟踪路径仅在 `deleteUntracked` 时用 `clean -f -- <paths>` 删除显式列出的文件（不带 `-d`，
//   每批 ≤200 个路径，`clean` 不支持 `--pathspec-from-file`），
//   否则列进 `skipped`；
// - A3 T5（TD-8）：只删「执行时未跟踪 ∩ confirmedUntracked」（确认框里列出的路径）；
//   确认之后才变成未跟踪的路径进 `skipped`；不传 `confirmedUntracked` 视为空集，什么都不删；
// - 已经没有改动的路径不报错（回滚是幂等的），也不出现在任何列表里。

import type { RollbackValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import {
  CLEAN_BATCH_MAX,
  batches,
  parseWritePaths,
  pathspecArgs,
  payloadRecord,
  readPathStates,
  redactedFailure,
} from './write-support.ts'

export interface RollbackInput {
  paths: string[]
  deleteUntracked: boolean
  /** Untracked paths the user saw in the confirmation (TD-8); empty when absent. */
  confirmedUntracked: ReadonlySet<string>
}

export const rollbackOperation: WriteOperation<RollbackInput, Omit<RollbackValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.deleteUntracked !== 'boolean') {
      throw new GitCommandFailure('git/invalid-payload', 'deleteUntracked must be a boolean')
    }
    const confirmed = record.confirmedUntracked === undefined ? [] : parseWritePaths(record.confirmedUntracked, true)
    return {
      paths: parseWritePaths(record.paths),
      deleteUntracked: record.deleteUntracked,
      confirmedUntracked: new Set(confirmed),
    }
  },

  async run(ctx, input) {
    const states = await readPathStates(ctx, input.paths)
    const restore: string[] = []
    const keptStaged: string[] = []
    const untracked: string[] = []
    for (const path of input.paths) {
      const state = states.get(path)
      if (state === undefined) continue
      if (state.x === '?') {
        untracked.push(path)
        continue
      }
      if (state.y !== ' ') restore.push(path)
      if (state.x !== ' ') keptStaged.push(path)
    }

    if (restore.length > 0) {
      const spec = pathspecArgs(restore)
      const result = await ctx.git([...GIT_BASE_ARGV, 'restore', '--worktree', ...spec.args], { stdin: spec.stdin })
      if (result.exitCode !== 0) throw redactedFailure(result, 'git restore')
    }

    const deleted: string[] = []
    const skipped: string[] = []
    const remove: string[] = []
    for (const path of untracked) {
      if (input.deleteUntracked && input.confirmedUntracked.has(path)) remove.push(path)
      else skipped.push(path)
    }
    // `clean` has no `--pathspec-from-file`: bounded argv batches (A3 T1 spike).
    for (const batch of batches(remove, CLEAN_BATCH_MAX)) {
      const result = await ctx.git([...GIT_BASE_ARGV, 'clean', '-f', '-q', '--', ...batch])
      if (result.exitCode !== 0) throw redactedFailure(result, 'git clean')
      deleted.push(...batch)
    }
    return { restored: restore, deleted, keptStaged, skipped }
  },
}
