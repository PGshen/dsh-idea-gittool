// T7 store/建模：响应式档位、分组排序、搜索、HEAD、单击/双击、版本丢弃。
import { describe, expect, it, vi } from 'vitest'
import type { BranchEntry } from '../../../src/shared/protocol.ts'
import {
  createBranchActivator,
  createBranchesStore,
  DEFAULT_COLLAPSED_GROUPS,
  formatAheadBehind,
  groupBranches,
  panelModeForWidth,
  shortSha,
} from '../../../src/client/pages/branch-store.ts'
import { branchesFixture, detachedBranchesFixture } from './branch-fixtures.ts'

const entryOf = (name: string): BranchEntry => {
  const entry = branchesFixture().local.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`missing fixture branch ${name}`)
  return entry
}

describe('panelModeForWidth', () => {
  it('按 300–599 / 600–999 / ≥1000 分三档', () => {
    expect(panelModeForWidth(300)).toBe('compact')
    expect(panelModeForWidth(599)).toBe('compact')
    expect(panelModeForWidth(600)).toBe('standard')
    expect(panelModeForWidth(999)).toBe('standard')
    expect(panelModeForWidth(1000)).toBe('wide')
    expect(panelModeForWidth(1600)).toBe('wide')
  })

  it('宽度缺失或非法时退回 standard', () => {
    expect(panelModeForWidth(Number.NaN)).toBe('standard')
    expect(panelModeForWidth(Number.POSITIVE_INFINITY)).toBe('standard')
  })
})

describe('formatAheadBehind / shortSha', () => {
  it('只显示非零方向', () => {
    expect(formatAheadBehind(1, 2)).toBe('↑1 ↓2')
    expect(formatAheadBehind(0, 2)).toBe('↓2')
    expect(formatAheadBehind(3, 0)).toBe('↑3')
    expect(formatAheadBehind(0, 0)).toBe('')
  })

  it('短哈希取 7 位', () => {
    expect(shortSha('aaa111122223333')).toBe('aaa1111')
    expect(shortSha('')).toBe('')
  })
})

describe('groupBranches', () => {
  it('按 HEAD → Local → Remote → Tags 输出四组', () => {
    const groups = groupBranches(branchesFixture())
    expect(groups.map(group => group.kind)).toEqual(['head', 'local', 'remote', 'tags'])
    expect(groups.map(group => group.label)).toEqual(['HEAD', 'Local', 'Remote', 'Tags'])
  })

  it('HEAD 组给出当前分支并标记 current/head', () => {
    const head = groupBranches(branchesFixture())[0]
    const row = head?.rows[0]
    expect(row?.kind).toBe('branch')
    expect(row?.label).toBe('main')
    expect(row?.current).toBe(true)
    expect(row?.head).toBe(true)
    expect(row?.detached).toBe(false)
    expect(row?.upstream).toBe('origin/main')
    expect(row?.ahead).toBe(1)
    expect(row?.behind).toBe(2)
  })

  it('detached HEAD 生成伪行并带 detached 说明', () => {
    const head = groupBranches(detachedBranchesFixture())[0]
    const row = head?.rows[0]
    expect(row?.detached).toBe(true)
    expect(row?.current).toBe(false)
    expect(row?.label).toBe('deadbee')
    expect(row?.entry?.sha).toBe('deadbee11112222333344445555666677778888')
  })

  it('Local 当前分支排最前，其余按名称排序，目录收拢在根分支之后', () => {
    const local = groupBranches(branchesFixture())[1]
    expect(local?.total).toBe(4)
    expect(local?.rows.map(row => `${row.kind}:${row.label}`)).toEqual([
      'branch:main',
      'branch:chore',
      'directory:feat',
      'branch:login',
      'branch:ui',
    ])
    expect(local?.rows[3]?.depth).toBe(1)
    expect(local?.rows[2]?.childCount).toBe(2)
  })

  it('Remote 按 remote 名分组（目录行），Tags 保持扁平', () => {
    const groups = groupBranches(branchesFixture())
    const remote = groups[2]
    const tags = groups[3]
    expect(remote?.rows.map(row => `${row.kind}:${row.label}`)).toEqual([
      'directory:origin',
      'branch:main',
      'directory:feat',
      'branch:login',
    ])
    expect(tags?.rows.map(row => row.label)).toEqual(['v0.9.0', 'v1.0.0'])
    expect(tags?.rows.every(row => row.kind === 'branch')).toBe(true)
  })

  it('flat 模式不生成目录行，名称用完整 ref 短名', () => {
    const local = groupBranches(branchesFixture(), { flat: true })[1]
    expect(local?.rows.every(row => row.kind === 'branch')).toBe(true)
    expect(local?.rows.map(row => row.label)).toEqual(['main', 'chore', 'feat/login', 'feat/ui'])
  })

  it('搜索按名称过滤且大小写不敏感，目录只保留命中的子树', () => {
    const groups = groupBranches(branchesFixture(), { search: 'LOGIN' })
    const local = groups[1]
    const remote = groups[2]
    expect(local?.total).toBe(1)
    expect(local?.rows.map(row => `${row.kind}:${row.label}`)).toEqual(['directory:feat', 'branch:login'])
    expect(remote?.total).toBe(1)
    expect(remote?.rows.map(row => `${row.kind}:${row.label}`)).toEqual([
      'directory:origin',
      'directory:feat',
      'branch:login',
    ])
    expect(groups[0]?.total).toBe(0)
    expect(groups[3]?.total).toBe(0)
  })

  it('折叠分组只清空 rows，total 保留', () => {
    const local = groupBranches(branchesFixture(), { collapsedGroups: { local: true } })[1]
    expect(local?.collapsed).toBe(true)
    expect(local?.rows).toEqual([])
    expect(local?.total).toBe(4)
  })

  it('折叠目录隐藏子行但保留目录行与 childCount', () => {
    const local = groupBranches(branchesFixture(), { collapsedDirs: { feat: true } })[1]
    expect(local?.rows.map(row => row.label)).toEqual(['main', 'chore', 'feat'])
    expect(local?.rows[2]?.directoryCollapsed).toBe(true)
    expect(local?.rows[2]?.childCount).toBe(2)
  })

  it('value 为 null 时返回空数组', () => {
    expect(groupBranches(null)).toEqual([])
  })
})

describe('createBranchActivator', () => {
  interface Scheduled { callback: () => void; cancelled: boolean }

  const setup = () => {
    const scheduled: Scheduled[] = []
    const navigated: string[] = []
    const filtered: string[] = []
    const activator = createBranchActivator({
      onNavigate: entry => navigated.push(entry.name),
      onFilter: entry => filtered.push(entry.name),
      delayMs: 200,
      schedule: (callback) => {
        scheduled.push({ callback, cancelled: false })
        return scheduled.length - 1
      },
      cancel: (handle) => {
        const task = scheduled[handle]
        if (task !== undefined) task.cancelled = true
      },
    })
    const run = (): void => {
      for (const task of scheduled) {
        if (!task.cancelled) task.callback()
      }
    }
    return { activator, scheduled, navigated, filtered, run }
  }

  it('单击延迟导航，不触发过滤', () => {
    const { activator, navigated, filtered, run, scheduled } = setup()
    activator.onClick(entryOf('feat/login'))
    expect(navigated).toEqual([])
    expect(scheduled).toHaveLength(1)
    run()
    expect(navigated).toEqual(['feat/login'])
    expect(filtered).toEqual([])
  })

  it('双击取消待执行的单击，只触发过滤', () => {
    const { activator, navigated, filtered, scheduled } = setup()
    activator.onClick(entryOf('feat/login'))
    activator.onClick(entryOf('feat/login'))
    activator.onDoubleClick(entryOf('feat/login'))
    expect(scheduled[0]?.cancelled).toBe(true)
    expect(navigated).toEqual([])
    expect(filtered).toEqual(['feat/login'])
  })

  it('cancel 会取消尚未执行的单击', () => {
    const { activator, navigated, run } = setup()
    activator.onClick(entryOf('main'))
    activator.cancel()
    run()
    expect(navigated).toEqual([])
  })
})

describe('createBranchesStore', () => {
  it('默认 UI 状态：standard、关闭、Remote/Tags 折叠、目录分组', () => {
    const store = createBranchesStore()
    const state = store.getState()
    expect(state.mode).toBe('standard')
    expect(state.open).toBe(false)
    expect(state.flat).toBe(false)
    expect(state.collapsedGroups).toEqual(DEFAULT_COLLAPSED_GROUPS)
  })

  it('setValue / setSearch / toggleGroup / toggleDirectory 通知订阅者', () => {
    const store = createBranchesStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.setValue(branchesFixture())
    expect(store.getState().value?.local).toHaveLength(4)
    store.setSearch('feat')
    expect(store.getState().search).toBe('feat')
    store.toggleGroup('remote')
    expect(store.getState().collapsedGroups.remote).toBe(false)
    store.toggleDirectory('feat')
    expect(store.getState().collapsedDirs.feat).toBe(true)
    store.toggleDirectory('feat')
    expect(store.getState().collapsedDirs.feat).toBe(undefined)
    expect(listener).toHaveBeenCalledTimes(6)
    unsubscribe()
    store.setSearch('chore')
    expect(listener).toHaveBeenCalledTimes(6)
  })

  it('按宽度切换档位，并记录抽屉/常驻栏的显隐', () => {
    const store = createBranchesStore()
    store.setWidth(400)
    expect(store.getState().mode).toBe('compact')
    store.setOpen(true)
    expect(store.getState().open).toBe(true)
    store.setWidth(1200)
    expect(store.getState().mode).toBe('wide')
    store.setWideCollapsed(true)
    expect(store.getState().wideCollapsed).toBe(true)
  })

  it('丢弃更旧 version 的 branches 响应', () => {
    const store = createBranchesStore()
    store.setValue(branchesFixture())
    store.setValue({ ...branchesFixture(), version: 3, local: [] })
    expect(store.getState().value?.local).toHaveLength(4)
    store.setValue({ ...branchesFixture(), version: 8, local: [] })
    expect(store.getState().value?.local).toHaveLength(0)
  })

  it('失败后清空 loading，成功时清空 error', () => {
    const store = createBranchesStore()
    store.setLoading(true)
    store.setError({ code: 'git/exec-failed', message: 'boom' })
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error?.code).toBe('git/exec-failed')
    store.setValue(branchesFixture())
    expect(store.getState().error).toBeNull()
  })

  it('reset 回到初始状态', () => {
    const store = createBranchesStore()
    store.setSearch('x')
    store.setValue(branchesFixture())
    store.reset()
    expect(store.getState().search).toBe('')
    expect(store.getState().value).toBeNull()
  })
})
