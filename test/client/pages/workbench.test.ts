// A1 工作台接线：日志选择 → 详情动作、Diff 文件列表展开。
import { describe, expect, it } from 'vitest'
import { detailActionFor, diffFilesOf } from '../../../src/client/pages/GitWorkbench.tsx'
import type { CommitDetailValue, CommitSummary } from '../../../src/shared/protocol.ts'

function summary(sha: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'a', email: 'a@x', date: '2026-10-25T00:00:00Z', subject: sha }
}

function detail(overrides: Partial<CommitDetailValue> = {}): CommitDetailValue {
  return {
    sha: 'c1',
    shortSha: 'c1',
    parents: [],
    author: { name: 'a', email: 'a@x', date: '2026-10-25T00:00:00Z' },
    committer: { name: 'a', email: 'a@x', date: '2026-10-25T00:00:00Z' },
    subject: 's',
    body: '',
    refs: [],
    files: [{ path: 'a.txt', status: 'M' }],
    truncated: false,
    ...overrides,
  }
}

describe('detailActionFor', () => {
  it('焦点行变化时加载新提交', () => {
    expect(detailActionFor({ shas: ['b'], commit: summary('b'), commits: [] }, 'a')).toEqual({ kind: 'select', sha: 'b' })
  })

  it('焦点行未变时保持', () => {
    expect(detailActionFor({ shas: ['a'], commit: summary('a'), commits: [] }, 'a')).toEqual({ kind: 'keep' })
  })

  it('筛选/重建清空选中时清掉详情，避免显示已不在列表里的提交', () => {
    expect(detailActionFor({ shas: [], commit: null, commits: [] }, 'a')).toEqual({ kind: 'clear' })
    expect(detailActionFor({ shas: [], commit: null, commits: [] }, null)).toEqual({ kind: 'keep' })
  })
})

describe('diffFilesOf', () => {
  it('普通提交直接用 files', () => {
    expect(diffFilesOf(detail())).toEqual([{ path: 'a.txt', status: 'M' }])
  })

  it('合并提交按父分组展开并带上 parentSha', () => {
    const value = detail({
      parentGroups: [
        { parentSha: 'p1', files: [{ path: 'a.txt', status: 'M' }] },
        { parentSha: 'p2', files: [{ path: 'b.txt', status: 'A' }] },
      ],
    })
    expect(diffFilesOf(value)).toEqual([
      { path: 'a.txt', status: 'M', parentSha: 'p1' },
      { path: 'b.txt', status: 'A', parentSha: 'p2' },
    ])
  })
})
