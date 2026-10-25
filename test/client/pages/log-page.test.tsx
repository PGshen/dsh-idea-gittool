/**
 * 日志页组件（设计 §8.1.2 / §8.1.3 / §14.1）：筛选栏胶囊、refs 胶囊、虚拟化行数、
 * 键盘翻译、空态/错误态。没有 DOM 环境：组件用 renderToStaticMarkup，交互逻辑走纯函数与 store。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { FilterBar, closeOpenMenus, filterChips, hasActiveFilter, menuContaining, toggleValue } from '../../../src/client/pages/FilterBar.tsx'
import type { FilterBarProps } from '../../../src/client/pages/FilterBar.tsx'
import { LogPage, branchOptionsFromRefs, selectionOf } from '../../../src/client/pages/LogPage.tsx'
import type { LogPageProps } from '../../../src/client/pages/LogPage.tsx'
import { LogRow, formatLogDate, rowModifiers } from '../../../src/client/pages/LogRow.tsx'
import { LOG_OVERSCAN, LogTable, shouldLoadMore, toLogKeyInput } from '../../../src/client/pages/LogTable.tsx'
import type { LogTableProps } from '../../../src/client/pages/LogTable.tsx'
import { MAX_REF_CHIPS, RefChips, splitRefs } from '../../../src/client/pages/RefChips.tsx'
import { DEFAULT_LOG_FILTER, LOG_MAX_ROWS, createLogStore } from '../../../src/client/store/log-store.ts'
import type { LogFilterState, LogStore, LogTableData } from '../../../src/client/store/log-store.ts'
import type { CommitSummary, LogValue, RefEntry, RpcResult } from '../../../src/shared/protocol.ts'

describe('RefChips', () => {
  const refs: RefEntry[] = [
    ref('refs/tags/v1', 'v1', 'tag'),
    ref('refs/remotes/origin/main', 'origin/main', 'remote'),
    ref('refs/heads/feature', 'feature', 'local'),
    ref('refs/heads/main', 'main', 'local'),
    ref('refs/tags/v2', 'v2', 'tag'),
  ]

  it('puts the current branch first, then local, remote and tags', () => {
    const { visible, hidden } = splitRefs(refs, 'main')
    expect(visible.map((item) => item.name)).toEqual(['main', 'feature', 'origin/main'])
    expect(visible[0]?.kind).toBe('head')
    expect(hidden.map((item) => item.name)).toEqual(['v1', 'v2'])
  })

  it('shows at most three chips plus a +n chip that lists the rest on hover', () => {
    const html = renderToStaticMarkup(<RefChips refs={refs} currentBranch="main" />)
    expect(MAX_REF_CHIPS).toBe(3)
    expect(html).toContain('>main<')
    expect(html).not.toContain('>v1<')
    expect(html).toContain('+2')
    expect(html).toContain('title="v1\nv2"')
  })

  it('renders nothing without refs', () => {
    expect(renderToStaticMarkup(<RefChips refs={[]} />)).toBe('')
  })
})

describe('FilterBar', () => {
  it('turns active filters into removable chips', () => {
    const filter: LogFilterState = {
      ...DEFAULT_LOG_FILTER,
      branches: ['main', 'dev'],
      authors: ['Alice'],
      order: 'topo',
      firstParent: true,
      noMerges: true,
    }
    const chips = filterChips(filter)
    expect(chips.map((chip) => chip.label)).toEqual([
      '分支: main', '分支: dev', '用户: Alice', '拓扑排序', '仅第一父提交', '不显示合并提交',
    ])
    expect(chips[0]?.remove).toEqual({ branches: ['dev'] })
    expect(chips[2]?.remove).toEqual({ authors: [] })
    expect(chips[3]?.remove).toEqual({ order: 'date' })
  })

  it('has no chips and no active filter by default', () => {
    expect(filterChips(DEFAULT_LOG_FILTER)).toEqual([])
    expect(hasActiveFilter(DEFAULT_LOG_FILTER)).toBe(false)
    expect(hasActiveFilter({ ...DEFAULT_LOG_FILTER, query: 'x' })).toBe(true)
    expect(hasActiveFilter({ ...DEFAULT_LOG_FILTER, noMerges: true })).toBe(true)
  })

  it('toggles multi-select values without reordering', () => {
    expect(toggleValue(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleValue(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('renders search with .* / Aa toggles, menus and the chip row', () => {
    const html = renderFilterBar({
      query: 'fix',
      filter: { ...DEFAULT_LOG_FILTER, regex: true, branches: ['main'] },
      branchOptions: [{ name: 'main', kind: 'local' }, { name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }],
      authorOptions: ['Alice', 'Bob'],
    })
    expect(html).toContain('placeholder="文本或哈希"')
    expect(html).toContain('value="fix"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>\.\*</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Aa</)
    expect(html).toContain('data-menu="branches"')
    expect(html).toContain('分支 (1) ▾')
    expect(html).toContain('>本地<')
    expect(html).toContain('>远程<')
    expect(html).toContain('>标签<')
    expect(html).toContain('data-menu="authors"')
    expect(html).toContain('>Bob<')
    expect(html).toContain('data-menu="graph"')
    expect(html).toContain('data-filter-chips')
    expect(html).toContain('分支: main ×')
  })

  it('frames the jump input in red when the jump failed', () => {
    const ok = renderFilterBar({ jumpError: null })
    expect(ok).toContain('aria-invalid="false"')
    expect(ok).not.toContain('role="alert"')

    const failed = renderFilterBar({ jumpError: '未找到「nope」' })
    expect(failed).toContain('aria-invalid="true"')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('未找到「nope」')
  })
})

describe('LogRow', () => {
  it('renders graph, subject, refs, author, date and short hash', () => {
    const data = tableData(commit('abcdef1234', 'p'), [ref('refs/heads/main', 'main', 'local', 'abcdef1234')])
    const html = renderToStaticMarkup(
      <LogRow data={data} index={0} selected multi={false} active head currentBranch="main" now={Date.parse('2026-10-25T00:00:00+08:00')} />,
    )
    expect(html).toContain('role="row"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('<svg')
    expect(html).toContain('subject abcdef1234')
    expect(html).toContain('>main<')
    expect(html).toContain('>Alice<')
    expect(html).toContain('>abcdef1<')
  })

  it('formats dates compactly and maps modifier keys', () => {
    const now = Date.parse('2026-10-25T12:00:00')
    expect(formatLogDate('2026-10-24T18:12:00', now)).toBe('10-24 18:12')
    expect(formatLogDate('2025-03-01T08:00:00', now)).toBe('2025-03-01')
    expect(formatLogDate('not a date', now)).toBe('not a date')
    expect(rowModifiers({ shiftKey: true, metaKey: false, ctrlKey: false })).toEqual({ shift: true, toggle: false })
    expect(rowModifiers({ shiftKey: false, metaKey: false, ctrlKey: true })).toEqual({ shift: false, toggle: true })
  })
})

describe('LogTable virtualization', () => {
  it('renders only the visible window of a 2000-row history', () => {
    const rows = Array.from({ length: LOG_MAX_ROWS }, (_, index) => tableData(commit(`s${index}`, `s${index + 1}`)))
    const html = renderTable({ rows, viewportHeight: 520 })
    const rendered = html.match(/role="row"/g)?.length ?? 0
    // 520px / 26px = 20 行可见 + overscan。
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThanOrEqual(20 + LOG_OVERSCAN + 1)
    expect(html).toContain(`aria-rowcount="${LOG_MAX_ROWS}"`)
    // 画布高度 = 全部行 × 26px，滚动条长度正确。
    expect(html).toContain(`height:${LOG_MAX_ROWS * 26}px`)
    expect(html).toContain('data-sha="s0"')
    expect(html).not.toContain('data-sha="s1999"')
  })

  it('marks selection, multi-select and the active descendant', () => {
    const rows = [tableData(commit('a', 'b')), tableData(commit('b', 'c')), tableData(commit('c'))]
    const html = renderTable({ rows, selection: ['a', 'b'], activeIndex: 1 })
    expect(html).toContain('role="grid"')
    expect(html).toContain('aria-multiselectable="true"')
    expect(html).toContain('aria-activedescendant="git-log-row-b"')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(2)
  })

  it('shows the loading footer and the row-limit hint', () => {
    const rows = [tableData(commit('a'))]
    expect(renderTable({ rows, loadingMore: true })).toContain('加载更多提交…')
    expect(renderTable({ rows, atRowLimit: true })).toContain('已显示前 1 个提交')
    const failed = renderTable({ rows, footerError: { message: '网络断了', onRetry: () => {} } })
    expect(failed).toContain('网络断了')
    expect(failed).toContain('重试')
  })

  it('asks for the next page only near the end', () => {
    expect(shouldLoadMore(10, 100)).toBe(false)
    expect(shouldLoadMore(79, 100)).toBe(true)
    expect(shouldLoadMore(5, 6)).toBe(true)
    expect(shouldLoadMore(-1, 0)).toBe(false)
  })
})

describe('keyboard translation (§14.1)', () => {
  it('passes table keys with shift and drops the rest', () => {
    expect(toLogKeyInput(key('ArrowDown', { shiftKey: true }))).toEqual({ key: 'ArrowDown', shiftKey: true })
    for (const name of ['ArrowUp', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']) {
      expect(toLogKeyInput(key(name))?.key).toBe(name)
    }
    expect(toLogKeyInput(key('x'))).toBeNull()
    expect(toLogKeyInput(key('ArrowDown', { altKey: true }))).toBeNull()
  })

  it('maps Cmd/Ctrl+A and Cmd/Ctrl+C, and leaves other primary combos to DSH', () => {
    expect(toLogKeyInput(key('a', { metaKey: true }))).toEqual({ key: 'a', primary: true })
    expect(toLogKeyInput(key('C', { ctrlKey: true }))).toEqual({ key: 'c', primary: true })
    expect(toLogKeyInput(key('k', { metaKey: true }))).toBeNull()
  })

  it('drives selection through the store end to end', async () => {
    const store = await loadedStore(range(0, 300))
    const press = (name: string, extra: Partial<KeyLike> = {}): void => {
      const input = toLogKeyInput(key(name, extra))
      if (input !== null) store.handleKey(input)
    }
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown', { shiftKey: true })
    expect(store.getState().selection).toEqual(['s1', 's2'])
    press('End')
    expect(store.getState().activeIndex).toBe(299)
    press('PageUp')
    expect(store.getState().activeIndex).toBe(199)
    press('Home')
    expect(store.getState().selection).toEqual(['s0'])
    press('ArrowRight')
    expect(store.getState().selection).toEqual(['s1'])
    press('ArrowLeft')
    expect(store.getState().selection).toEqual(['s0'])
    expect(store.handleKey({ key: 'Enter' }).action).toBe('open-diff')
  })
})

describe('LogPage', () => {
  it('shows a skeleton before the first page arrives', () => {
    const store = createLogStore({ sessionId: 's', loadPage: () => new Promise(() => {}) })
    const html = renderPage({ store, autoLoad: false })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('role="grid"')
  })

  it('renders the error state with a retry action', async () => {
    const store = createLogStore({
      sessionId: 's',
      loadPage: async () => ({ ok: false, error: { code: 'git/not-a-repository', message: '当前目录不是 Git 仓库' } }),
    })
    await store.loadFirstPage()
    const html = renderPage({ store })
    expect(html).toContain('role="alert"')
    expect(html).toContain('读取提交历史失败')
    expect(html).toContain('当前目录不是 Git 仓库')
    expect(html).toContain('重试')
  })

  it('distinguishes an empty repository from an empty filter result', async () => {
    const empty = await loadedStore([])
    expect(renderPage({ store: empty })).toContain('还没有提交')

    const filtered = await loadedStore([])
    filtered.setFilter({ authors: ['Nobody'] })
    await flush()
    const html = renderPage({ store: filtered })
    expect(html).toContain('没有匹配的提交')
    expect(html).toContain('清除筛选')
    expect(html).toContain('用户: Nobody ×')
  })

  it('renders the table, refs and the detail slot with the current selection', async () => {
    const store = await loadedStore([commit('a', 'b'), commit('b')])
    store.selectIndex(1)
    const renderDetail = vi.fn((selection: ReturnType<typeof selectionOf>) => (
      <div>detail:{selection.commit?.sha}</div>
    ))
    const html = renderPage({
      store,
      refsBySha: { a: [ref('refs/heads/main', 'main', 'local', 'a')] },
      headSha: 'a',
      currentBranch: 'main',
      renderDetail,
      sidebar: <nav>branches-slot</nav>,
    })
    expect(html).toContain('role="grid"')
    expect(html).toContain('data-log-detail')
    expect(html).toContain('detail:b')
    expect(html).toContain('branches-slot')
    expect(renderDetail).toHaveBeenCalledWith(expect.objectContaining({ shas: ['b'] }))
  })

  it('derives branch options from refs and snapshots the selection in table order', () => {
    const options = branchOptionsFromRefs({
      a: [ref('refs/tags/v1', 'v1', 'tag', 'a'), ref('refs/heads/main', 'main', 'local', 'a')],
      b: [ref('refs/remotes/origin/main', 'origin/main', 'remote', 'b'), ref('refs/heads/main', 'main', 'local', 'b')],
    })
    expect(options).toEqual([
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1', kind: 'tag' },
    ])

    const commits = [commit('a'), commit('b'), commit('c')]
    const snapshot = selectionOf({ commits, selection: ['c', 'a'], activeIndex: 2 })
    expect(snapshot.commits.map((item) => item.sha)).toEqual(['a', 'c'])
    expect(snapshot.commit?.sha).toBe('c')
    expect(selectionOf({ commits, selection: [], activeIndex: -1 }).commit).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface KeyLike {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

function key(name: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra }
}

function commit(sha: string, ...parents: string[]): CommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    author: 'Alice',
    email: 'alice@example.com',
    date: '2026-10-24T10:00:00+08:00',
    subject: `subject ${sha}`,
  }
}

function range(start: number, count: number): CommitSummary[] {
  return Array.from({ length: count }, (_, index) => commit(`s${start + index}`, `s${start + index + 1}`))
}

function ref(refName: string, name: string, kind: RefEntry['kind'], sha = 'x'): RefEntry {
  return { ref: refName, name, kind, sha }
}

function tableData(value: CommitSummary, refs: RefEntry[] = []): LogTableData {
  return { commit: value, graph: { sha: value.sha, lane: 0, colorId: 0, edges: [], width: 1 }, refs }
}

function renderFilterBar(overrides: Partial<FilterBarProps> = {}): string {
  const props: FilterBarProps = {
    query: '',
    filter: DEFAULT_LOG_FILTER,
    branchOptions: [],
    authorOptions: [],
    jumpError: null,
    onQueryChange: () => {},
    onQueryCommit: () => {},
    onQueryClear: () => {},
    onFilterChange: () => {},
    onJump: () => true,
    onJumpEdit: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<FilterBar {...props} />)
}

function renderTable(overrides: Partial<LogTableProps> = {}): string {
  const props: LogTableProps = {
    rows: [],
    selection: [],
    activeIndex: -1,
    generation: 1,
    headSha: null,
    currentBranch: null,
    loadingMore: false,
    atRowLimit: false,
    onRowClick: () => {},
    onRowOpen: () => {},
    onKey: () => ({ handled: false }),
    onNearEnd: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<LogTable {...props} />)
}

function renderPage(props: LogPageProps): string {
  return renderToStaticMarkup(<LogPage autoLoad={false} viewportHeight={520} {...props} />)
}

async function loadedStore(commits: CommitSummary[]): Promise<LogStore> {
  const value: LogValue = { commits, truncated: false }
  const store = createLogStore({
    sessionId: 's',
    loadPage: async (): Promise<RpcResult<LogValue>> => ({ ok: true, value: { ...value, commits: [...value.commits] } }),
  })
  await store.loadFirstPage()
  return store
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('FilterBar 菜单关闭', () => {
  function fakeMenu(open: boolean): { open: boolean; contains: (node: unknown) => boolean } {
    const menu = { open, contains: (node: unknown) => node === menu }
    return menu
  }

  it('关闭除 keep 之外所有已展开的菜单，返回关闭数', () => {
    const a = fakeMenu(true)
    const b = fakeMenu(true)
    const c = fakeMenu(false)
    const root = { querySelectorAll: () => [a, b, c] }
    expect(closeOpenMenus(root, b)).toBe(1)
    expect([a.open, b.open, c.open]).toEqual([false, true, false])
    expect(closeOpenMenus(root)).toBe(1)
    expect(b.open).toBe(false)
  })

  it('点击落在某个菜单内部时保留它', () => {
    const a = fakeMenu(true)
    const root = { querySelectorAll: () => [a] }
    expect(menuContaining([a], a)).toBe(a)
    expect(menuContaining([a], {})).toBeNull()
    expect(closeOpenMenus(root, menuContaining([a], {}))).toBe(1)
  })
})
