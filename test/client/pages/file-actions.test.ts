// B2 T7：文件动作的可用性矩阵（提交详情变更文件 / 提交页变更树）。
import { describe, expect, it } from 'vitest'
import { fileActions } from '../../../src/client/pages/file-actions.ts'

const view = (items: ReturnType<typeof fileActions>): Array<[string, string | undefined]> =>
  items.map(item => [item.id, item.disabledReason?.key])

describe('fileActions', () => {
  it('commit file: diff, history, blame this revision, compare with worktree, copy path', () => {
    expect(view(fileActions({ kind: 'commitFile', status: 'M' }))).toEqual([
      ['showDiff', undefined], ['fileHistory', undefined], ['blameRevision', undefined], ['compareWorktree', undefined], ['copyPath', undefined],
    ])
  })

  it('commit file deleted by that commit: no blame of this revision', () => {
    expect(view(fileActions({ kind: 'commitFile', status: 'D' })).find(([id]) => id === 'blameRevision')).toEqual(['blameRevision', 'file.disabled.deletedHere'])
  })

  it('worktree change: history and blame; never committed files have neither', () => {
    expect(view(fileActions({ kind: 'change', status: 'M' }))).toEqual([['fileHistory', undefined], ['blame', undefined]])
    expect(view(fileActions({ kind: 'change', status: '?' }))).toEqual([
      ['fileHistory', 'file.disabled.untracked'], ['blame', 'file.disabled.untracked'],
    ])
    expect(view(fileActions({ kind: 'change', status: 'A' }))).toEqual([
      ['fileHistory', 'file.disabled.untracked'], ['blame', 'file.disabled.untracked'],
    ])
  })

  it('worktree deletion keeps history but cannot blame the worktree', () => {
    expect(view(fileActions({ kind: 'change', status: 'D' }))).toEqual([['fileHistory', undefined], ['blame', 'file.disabled.deletedWorktree']])
  })
})
