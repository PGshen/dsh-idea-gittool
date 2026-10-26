// A1 工作台接线：日志选择 → 详情动作、Diff 文件列表展开。
import { describe, expect, it } from 'vitest'
import { changeFilesFor, detailActionFor, diffFilesOf, logRefreshKey, rollbackTargetsFor } from '../../../src/client/pages/GitWorkbench.tsx'
import type { CommitDetailValue, CommitSummary, StatusValue } from '../../../src/shared/protocol.ts'

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
    expect(detailActionFor({ shas: [], commit: null, commits: [] }, 'a', true)).toEqual({ kind: 'clear' })
    expect(detailActionFor({ shas: [], commit: null, commits: [] }, null, true)).toEqual({ kind: 'keep' })
  })

  it('刷新（非筛选重建）导致的选中清空不清详情，正在看的提交保留', () => {
    expect(detailActionFor({ shas: [], commit: null, commits: [] }, 'a', false)).toEqual({ kind: 'keep' })
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

describe('logRefreshKey', () => {
  const ref = (name: string, sha: string) => ({ ref: `refs/heads/${name}`, name, kind: 'local' as const, sha })

  it('只在 HEAD 或 refs 变化时变化（index/工作区变化不影响日志）', () => {
    const base = logRefreshKey('h1', { h1: [ref('main', 'h1')] })
    expect(logRefreshKey('h1', { h1: [ref('main', 'h1')] })).toBe(base)
    expect(logRefreshKey('h2', { h1: [ref('main', 'h1')] })).not.toBe(base)
    expect(logRefreshKey('h1', { h1: [ref('main', 'h1')], x: [ref('topic', 'x')] })).not.toBe(base)
  })

  it('与 refs 的对象键顺序无关', () => {
    const a = logRefreshKey('h', { x: [ref('a', 'x')], y: [ref('b', 'y')] })
    const b = logRefreshKey('h', { y: [ref('b', 'y')], x: [ref('a', 'x')] })
    expect(a).toBe(b)
  })
})

function status(): StatusValue {
  return {
    branch: 'main', detached: false, head: 'h', upstream: null, ahead: 0, behind: 0,
    staged: [{ path: 's.txt', status: 'M' }],
    unstaged: [{ path: 'u.txt', status: 'M' }],
    untracked: [{ path: 'n.txt', status: '?' }],
    conflicts: [{ path: 'c.txt', status: 'U' }],
    operation: null, truncated: false,
  }
}

describe('changeFilesFor', () => {
  it('暂存区 diff 只在已暂存文件间切换；工作区 diff 覆盖冲突、未暂存与未跟踪', () => {
    expect(changeFilesFor(status(), 'staged').map(f => f.path)).toEqual(['s.txt'])
    expect(changeFilesFor(status(), 'worktree').map(f => f.path)).toEqual(['c.txt', 'u.txt', 'n.txt'])
    expect(changeFilesFor(null, 'worktree')).toEqual([])
  })
})

describe('rollbackTargetsFor', () => {
  it('按 status 标记未跟踪文件（需要删除确认）', () => {
    expect(rollbackTargetsFor(status(), ['u.txt', 'n.txt'])).toEqual([
      { path: 'u.txt', untracked: false },
      { path: 'n.txt', untracked: true },
    ])
  })
})
