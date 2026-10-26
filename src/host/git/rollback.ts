// 回滚写操作（A2 T2，设计 §8.2.5）：
// - 已跟踪路径只丢弃工作区改动（`restore --worktree`），暂存内容保留并在 `keptStaged` 里列出；
// - 未跟踪路径仅在 `deleteUntracked` 时用 `clean -f -- <paths>` 删除显式列出的文件（不带 `-d`），
//   否则列进 `skipped`；
// - 已经没有改动的路径不报错（回滚是幂等的），也不出现在任何列表里。

import type { RollbackValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { parseWritePaths, payloadRecord, readPathStates, redactedFailure } from './write-support.ts'

export interface RollbackInput {
  paths: string[]
  deleteUntracked: boolean
}

export const rollbackOperation: WriteOperation<RollbackInput, Omit<RollbackValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.deleteUntracked !== 'boolean') {
      throw new GitCommandFailure('git/invalid-payload', 'deleteUntracked must be a boolean')
    }
    return { paths: parseWritePaths(record.paths), deleteUntracked: record.deleteUntracked }
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
      const result = await ctx.git([...GIT_BASE_ARGV, 'restore', '--worktree', '--', ...restore])
      if (result.exitCode !== 0) throw redactedFailure(result, 'git restore')
    }

    const deleted: string[] = []
    const skipped: string[] = []
    if (untracked.length > 0) {
      if (input.deleteUntracked) {
        const result = await ctx.git([...GIT_BASE_ARGV, 'clean', '-f', '-q', '--', ...untracked])
        if (result.exitCode !== 0) throw redactedFailure(result, 'git clean')
        deleted.push(...untracked)
      } else {
        skipped.push(...untracked)
      }
    }
    return { restored: restore, deleted, keptStaged, skipped }
  },
}
