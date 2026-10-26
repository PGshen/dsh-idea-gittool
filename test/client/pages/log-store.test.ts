/**
 * 日志 store：分页去重、筛选重建、防抖、选择与键盘（设计 §8.1.2 / §8.1.3 / §14.1）。
 * React-free，直接驱动，不需要 DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import { render } from '../../../src/client/localized-text.ts'

import {
  LOG_EMPTY_PAGE_FOLLOW_LIMIT,
  LOG_MAX_ROWS,
  LOG_PAGE_SIZE,
  LOG_SEARCH_DEBOUNCE_MS,
  createLogStore,
  findRefSha,
} from '../../../src/client/store/log-store.ts'
import type { LogStore, LogStoreOptions } from '../../../src/client/store/log-store.ts'
import type { CommitSummary, LogRequest, LogValue, RefEntry, RpcResult } from '../../../src/shared/protocol.ts'

describe('pagination', () => {
  it('appends pages, keeps the cursor chain and dedupes repeated commits', async () => {
    const { store, requests } = harness([
      page([commit('a', 'b'), commit('b', 'c')], 'cursor-2'),
      // 第二页重复返回 b（游标漂移时的兜底），只应追加 c。
      page([commit('b', 'c'), commit('c')]),
    ], { pageSize: 100 })

    await store.loadFirstPage()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b'])
    expect(store.getState().next).toBe('cursor-2')

    await store.loadNextPage()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b', 'c'])
    expect(store.getState().next).toBeUndefined()
    expect(requests.map((request) => request.cursor)).toEqual([undefined, 'cursor-2'])
    expect(requests.every((request) => request.limit === 100)).toBe(true)
  })

  it('follows empty search pages that still carry a cursor', async () => {
    // Host 搜索按预算扫描：可能返回空页 + next，客户端不能停在「无结果」。
    const { store, requests } = harness([
      page([], 'c1'),
      page([], 'c2'),
      page([commit('a')], 'c3'),
      page([], 'c4'),
      page([commit('b')]),
    ])

    await store.loadFirstPage()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a'])
    expect(store.getState().loading).toBe(false)
    expect(requests.map((request) => request.cursor)).toEqual([undefined, 'c1', 'c2'])

    await store.loadNextPage()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b'])
    expect(store.getState().next).toBeUndefined()
  })

  it('gives up following empty pages after a bounded number of requests', async () => {
    let served = 0
    const store = createLogStore({
      sessionId: 's',
      loadPage: async () => {
        served += 1
        return ok(page([], `c${served}`))
      },
    })

    await store.loadFirstPage()
    expect(served).toBe(LOG_EMPTY_PAGE_FOLLOW_LIMIT + 1)
    expect(store.getState().commits).toEqual([])
    // 游标仍保留：用户滚动/重试时可以继续。
    expect(store.getState().next).toBe(`c${served}`)
  })

  it('stops at 2000 rows even when the host keeps returning a cursor', async () => {
    let served = 0
    const store = createLogStore({
      sessionId: 's',
      pageSize: 100,
      maxRows: LOG_MAX_ROWS,
      loadPage: async (request) => {
        const offset = Number(request.cursor ?? 0)
        served += 1
        return ok(page(range(offset, 100), String(offset + 100)))
      },
    })

    await store.loadFirstPage()
    for (let i = 0; i < 30; i += 1) await store.loadNextPage()

    expect(store.getState().commits).toHaveLength(LOG_MAX_ROWS)
    expect(store.getState().atRowLimit).toBe(true)
    expect(served).toBe(20)

    // 到上限后 loadNextPage 是空操作，不再发请求。
    await store.loadNextPage()
    expect(served).toBe(20)
  })

  it('does not stack requests when scrolling faster than the host answers', async () => {
    const deferred = deferredPage()
    const store = createLogStore({ sessionId: 's', loadPage: deferred.load })
    const firstPage = store.loadFirstPage()
    // 首页必须先应答（并带游标），否则 loadNextPage 无事可做。
    deferred.resolve(page([commit('a', 'b')], 'cursor-2'))
    await firstPage

    const first = store.loadNextPage()
    const second = store.loadNextPage()
    deferred.resolve(page([commit('b')]))
    await Promise.all([first, second])

    expect(deferred.requests).toHaveLength(2) // 首页 + 一次下一页
    expect(store.getState().loadingMore).toBe(false)
  })

  it('keeps loaded rows when the next page fails and clears the error on retry', async () => {
    let failNext = true
    const store = createLogStore({
      sessionId: 's',
      loadPage: async (request) => {
        if (request.cursor === undefined) return ok(page([commit('a', 'b')], 'cursor-2'))
        if (failNext) {
          failNext = false
          return { ok: false, error: { code: 'git/exec-failed', message: '超时' } }
        }
        return ok(page([commit('b')]))
      },
    })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(store.getState().error?.message).toBe('超时')
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a'])
    expect(store.getState().next).toBe('cursor-2')

    await store.loadNextPage()
    expect(store.getState().error).toBeNull()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b'])
    // 图形行与提交一一对齐：失败那次没有往 layout 里塞任何东西。
    expect(store.getState().rows.map((row) => row.sha)).toEqual(['a', 'b'])
  })

  it('reports a structured error when the page fails', async () => {
    const store = createLogStore({
      sessionId: 's',
      loadPage: async () => ({ ok: false, error: { code: 'git/not-a-repository', message: '不是仓库' } }),
    })
    await store.loadFirstPage()
    expect(store.getState().error?.code).toBe('git/not-a-repository')
    expect(store.getState().loading).toBe(false)
  })
})

describe('filters', () => {
  it('sends the search options the host needs', async () => {
    const { store, requests } = harness([page([])])
    await store.loadFirstPage()
    store.setFilter({ query: 'fix:', regex: true, caseSensitive: true })
    await flush()

    const applied = requests[requests.length - 1]
    expect(applied?.query).toBe('fix:')
    expect(applied?.regex).toBe(true)
    expect(applied?.caseSensitive).toBe(true)
    expect(applied?.sessionId).toBe('s')
    expect(applied?.order).toBe('date')
  })

  it('sends branch, author and graph options', async () => {
    const { store, requests } = harness([page([])])
    await store.loadFirstPage()
    store.setFilter({ branches: ['main'], authors: ['Alice'], order: 'topo', firstParent: true, noMerges: true })
    await flush()

    const applied = requests[requests.length - 1]
    expect(applied?.branches).toEqual(['main'])
    expect(applied?.authors).toEqual(['Alice'])
    expect(applied?.order).toBe('topo')
    expect(applied?.firstParent).toBe(true)
    expect(applied?.noMerges).toBe(true)
  })

  it('rebuilds the graph and clears selection on a filter change', async () => {
    const { store } = harness([
      page([commit('a', 'b', 'c'), commit('b', 'c'), commit('c')], undefined),
      page([commit('b', 'c'), commit('c')]),
    ])
    await store.loadFirstPage()
    store.selectIndex(0)
    expect(store.getState().selection).toEqual(['a'])
    const generation = store.getState().generation

    store.setFilter({ noMerges: true })
    await flush()

    const state = store.getState()
    expect(state.generation).toBe(generation + 1)
    expect(state.selection).toEqual([])
    expect(state.commits.map((c) => c.sha)).toEqual(['b', 'c'])
    expect(state.rows.every((row) => row.width === 1)).toBe(true)
  })

  it('ignores a filter patch that changes nothing', async () => {
    const { store, requests } = harness([page([])])
    await store.loadFirstPage()
    store.setFilter({ order: 'date' })
    await flush()
    expect(requests).toHaveLength(1)
  })

  it('drops the response of a superseded request', async () => {
    const deferred = deferredPage()
    const store = createLogStore({ sessionId: 's', loadPage: deferred.load })

    const first = store.loadFirstPage()
    store.setFilter({ noMerges: true })
    const second = flush()

    // 旧请求后到：它的提交不能混进新筛选的结果。
    deferred.resolve(page([commit('stale')]))
    await Promise.all([first, second])
    deferred.resolve(page([commit('fresh')]))
    await flush()

    expect(store.getState().commits.map((c) => c.sha)).toEqual(['fresh'])
  })
})

describe('search debounce', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('applies the query only after 600ms', async () => {
    const { store, requests } = harness([page([]), page([])])
    await store.loadFirstPage()
    const before = requests.length

    store.setQuery('fix')
    expect(store.getState().query).toBe('fix')
    expect(store.getState().filter.query).toBe('')

    vi.advanceTimersByTime(LOG_SEARCH_DEBOUNCE_MS - 1)
    await flush()
    expect(requests).toHaveLength(before)

    vi.advanceTimersByTime(1)
    await flush()
    expect(requests).toHaveLength(before + 1)
    expect(requests[requests.length - 1]?.query).toBe('fix')
    expect(store.getState().filter.query).toBe('fix')
  })

  it('coalesces keystrokes into one request', async () => {
    const { store, requests } = harness([page([]), page([])])
    await store.loadFirstPage()
    const before = requests.length

    store.setQuery('f')
    vi.advanceTimersByTime(200)
    store.setQuery('fi')
    vi.advanceTimersByTime(200)
    store.setQuery('fix')
    vi.advanceTimersByTime(LOG_SEARCH_DEBOUNCE_MS)
    await flush()

    expect(requests).toHaveLength(before + 1)
    expect(requests[requests.length - 1]?.query).toBe('fix')
  })

  it('applies immediately on Enter and clears on Esc', async () => {
    const { store, requests } = harness([page([]), page([]), page([])])
    await store.loadFirstPage()

    store.setQuery('hotfix')
    store.commitQuery()
    await flush()
    expect(requests[requests.length - 1]?.query).toBe('hotfix')

    const cleared = store.handleKey({ key: 'Escape' })
    await flush()
    expect(cleared.action).toBe('clear-search')
    expect(store.getState().query).toBe('')
    expect(store.getState().filter.query).toBe('')
    expect(requests[requests.length - 1]?.query).toBeUndefined()
  })
})

describe('selection and keyboard', () => {
  async function readyStore(count = 5): Promise<LogStore> {
    const { store } = harness([page(range(0, count))])
    await store.loadFirstPage()
    return store
  }

  it('selects one row, extends with shift and toggles with primary', async () => {
    const store = await readyStore()
    store.selectIndex(1)
    expect(store.getState().selection).toEqual(['s1'])
    expect(store.getState().activeIndex).toBe(1)

    store.selectIndex(3, { shift: true })
    expect(store.getState().selection).toEqual(['s1', 's2', 's3'])

    store.selectIndex(0, { shift: true })
    expect(store.getState().selection).toEqual(['s0', 's1'])

    store.selectIndex(2, { toggle: true })
    expect(store.getState().selection).toEqual(['s0', 's1', 's2'])
    store.selectIndex(2, { toggle: true })
    expect(store.getState().selection).toEqual(['s0', 's1'])
  })

  it('moves with arrows and clamps at both ends', async () => {
    const store = await readyStore()
    store.handleKey({ key: 'ArrowDown' })
    expect(store.getState().activeIndex).toBe(0)
    store.handleKey({ key: 'ArrowDown' })
    expect(store.getState().activeIndex).toBe(1)
    store.handleKey({ key: 'ArrowUp' })
    expect(store.getState().activeIndex).toBe(0)
    store.handleKey({ key: 'ArrowUp' })
    expect(store.getState().activeIndex).toBe(0)
    expect(store.getState().selection).toEqual(['s0'])
  })

  it('pages with PgDn/PgUp and jumps with Home/End', async () => {
    const store = await readyStore(300)
    store.handleKey({ key: 'Home' })
    expect(store.getState().activeIndex).toBe(0)
    store.handleKey({ key: 'PageDown' })
    expect(store.getState().activeIndex).toBe(LOG_PAGE_SIZE)
    store.handleKey({ key: 'End' })
    expect(store.getState().activeIndex).toBe(299)
    store.handleKey({ key: 'PageUp' })
    expect(store.getState().activeIndex).toBe(199)
  })

  it('extends the multi-selection with shift+arrow', async () => {
    const store = await readyStore()
    store.selectIndex(2)
    store.handleKey({ key: 'ArrowDown', shiftKey: true })
    expect(store.getState().selection).toEqual(['s2', 's3'])
    store.handleKey({ key: 'ArrowUp', shiftKey: true })
    expect(store.getState().selection).toEqual(['s2'])
  })

  it('maps Enter to open-diff and primary+C to copy-hash', async () => {
    const store = await readyStore()
    expect(store.handleKey({ key: 'Enter' })).toEqual({ handled: false })
    store.selectIndex(2)
    expect(store.handleKey({ key: 'Enter' }).action).toBe('open-diff')
    expect(store.handleKey({ key: 'c', primary: true }).action).toBe('copy-hash')
  })

  it('selects every loaded commit with primary+A', async () => {
    const store = await readyStore(4)
    const result = store.handleKey({ key: 'a', primary: true })
    expect(result.action).toBe('select-all')
    expect(store.getState().selection).toHaveLength(4)
  })

  it('navigates to the child with ArrowLeft and the parent with ArrowRight', async () => {
    const { store } = harness([page([commit('a', 'b'), commit('b', 'c'), commit('c')])])
    await store.loadFirstPage()
    store.selectIndex(1) // b

    const toChild = store.handleKey({ key: 'ArrowLeft' })
    expect(toChild.targetIndex).toBe(0)
    expect(store.getState().selection).toEqual(['a'])

    const toParent = store.handleKey({ key: 'ArrowRight' })
    expect(toParent.targetIndex).toBe(1)
    expect(store.getState().selection).toEqual(['b'])
  })

  it('keeps the key unhandled when the row has no child or parent loaded', async () => {
    const { store } = harness([page([commit('a', 'b'), commit('b', 'c')])])
    await store.loadFirstPage()
    store.selectIndex(0)
    expect(store.handleKey({ key: 'ArrowLeft' })).toEqual({ handled: true })
    store.selectIndex(1)
    expect(store.handleKey({ key: 'ArrowRight' })).toEqual({ handled: true })
  })
})

describe('jump', () => {
  it('finds a commit by hash prefix', async () => {
    const { store } = harness([page([commit('alpha', 'a2'), commit('a2')])])
    await store.loadFirstPage()
    expect(store.jumpTo('a2')).toBe(true)
    expect(store.getState().selection).toEqual(['a2'])
  })

  it('finds a commit through a ref name', async () => {
    const { store } = harness([page([commit('alpha', 'a2'), commit('a2')])])
    await store.loadFirstPage()
    store.setRefs({ a2: [ref('refs/heads/feature/login', 'feature/login', 'local', 'a2')] })
    expect(findRefSha(store.getState().refsBySha, 'feature/login')).toBe('a2')
    expect(store.jumpTo('feature/login')).toBe(true)
    expect(store.getState().activeIndex).toBe(1)
  })

  it('reports a miss and clears it again', async () => {
    const { store } = harness([page([commit('a')])])
    await store.loadFirstPage()
    expect(store.jumpTo('nope')).toBe(false)
    expect(jumpText(store)).toContain('nope')
    store.clearJumpError()
    expect(store.getState().jumpError).toBeNull()
  })
})

describe('refresh', () => {
  it('keeps the selection when the commit is still there', async () => {
    const { store } = harness([
      page([commit('a', 'b'), commit('b')]),
      page([commit('a', 'b'), commit('b')]),
    ])
    await store.loadFirstPage()
    store.selectIndex(1)
    const generation = store.getState().generation

    await store.refresh()
    // 刷新整体替换列表，不会把同一批提交再追加一遍。
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b'])
    expect(store.getState().selection).toEqual(['b'])
    expect(store.getState().activeIndex).toBe(1)
    // 刷新不是筛选重建：表格不回到顶部。
    expect(store.getState().generation).toBe(generation)
  })

  it('reloads to the previously loaded depth so deep selections survive', async () => {
    const { store, requests } = harness([
      page([commit('a', 'b'), commit('b', 'c')], 'p2'),
      page([commit('c', 'd'), commit('d')]),
      // 刷新：第一页 + 跟到原深度的第二页。
      page([commit('a', 'b'), commit('b', 'c')], 'r2'),
      page([commit('c', 'd'), commit('d')]),
    ])
    await store.loadFirstPage()
    await store.loadNextPage()
    store.selectIndex(3)

    await store.refresh()

    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a', 'b', 'c', 'd'])
    expect(store.getState().selection).toEqual(['d'])
    expect(store.getState().activeIndex).toBe(3)
    expect(requests.map((request) => request.cursor)).toEqual([undefined, 'p2', undefined, 'r2'])
  })

  it('drops selected commits that disappeared', async () => {
    const { store } = harness([
      page([commit('a', 'b'), commit('b')]),
      page([commit('a')]),
    ])
    await store.loadFirstPage()
    store.selectIndex(1)
    await store.refresh()
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['a'])
    expect(store.getState().selection).toEqual([])
    expect(store.getState().activeIndex).toBe(-1)
  })
})

describe('table rows', () => {
  it('joins commits, graph rows and refs and caches the array', async () => {
    const { store } = harness([page([commit('a', 'b'), commit('b')])])
    await store.loadFirstPage()
    store.setRefs({ a: [ref('refs/heads/main', 'main', 'local', 'a')] })

    const first = store.getRows()
    expect(first).toHaveLength(2)
    expect(first[0]?.refs[0]?.name).toBe('main')
    expect(first[0]?.graph.lane).toBe(0)
    expect(store.getRows()).toBe(first)

    store.setRefs({ b: [ref('refs/tags/v1', 'v1', 'tag', 'b')] })
    const second = store.getRows()
    expect(second).not.toBe(first)
    expect(second[1]?.refs[0]?.name).toBe('v1')
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
  return Array.from({ length: count }, (_, index) => {
    const value = start + index
    return commit(`s${value}`, `s${value + 1}`)
  })
}

function ref(refName: string, name: string, kind: RefEntry['kind'], sha: string): RefEntry {
  return { ref: refName, name, kind, sha }
}

function page(commits: CommitSummary[], next?: string): LogValue {
  return { commits, truncated: false, ...(next === undefined ? {} : { next }) }
}

function ok(value: LogValue): RpcResult<LogValue> {
  return { ok: true, value }
}

interface HarnessResult {
  store: LogStore
  requests: LogRequest[]
}

function harness(pages: LogValue[], options: Partial<LogStoreOptions> = {}): HarnessResult {
  const requests: LogRequest[] = []
  const queue = [...pages]
  const store = createLogStore({
    sessionId: 's',
    ...options,
    loadPage: async (request) => {
      requests.push(request)
      const value = queue.shift() ?? { commits: [], truncated: false }
      return ok(value)
    },
  })
  return { store, requests }
}

interface DeferredPage {
  load: LogStoreOptions['loadPage']
  requests: LogRequest[]
  resolve(value: LogValue): void
}

function deferredPage(): DeferredPage {
  const requests: LogRequest[] = []
  const waiting: ((value: RpcResult<LogValue>) => void)[] = []
  return {
    requests,
    load: (request) => {
      requests.push(request)
      return new Promise((resolve) => { waiting.push(resolve) })
    },
    resolve: (value) => {
      const next = waiting.shift()
      next?.(ok(value))
    },
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('locate beyond loaded rows (评审 I4)', () => {
  it('pages forward until a hash prefix appears, then selects it', async () => {
    const { store } = harness([
      page([commit('aaa1', 'bbb2')], 'p2'),
      page([commit('bbb2', 'ccc3')], 'p3'),
      page([commit('ccc3')]),
    ])
    await store.loadFirstPage()

    expect(await store.locate('ccc')).toBe(true)
    expect(store.getState().commits.map((c) => c.sha)).toEqual(['aaa1', 'bbb2', 'ccc3'])
    expect(store.getState().selection).toEqual(['ccc3'])
    expect(store.getState().jumpError).toBeNull()
  })

  it('resolves a branch via refs and pages to its commit', async () => {
    const { store } = harness([
      page([commit('aaa1', 'bbb2')], 'p2'),
      page([commit('bbb2')]),
    ])
    await store.loadFirstPage()
    store.setRefs({ bbb2: [{ ref: 'refs/heads/topic', name: 'topic', kind: 'local', sha: 'bbb2' }] })

    expect(await store.locate('topic')).toBe(true)
    expect(store.getState().selection).toEqual(['bbb2'])
  })

  it('explains a ref outside the current view instead of a bare "not found"', async () => {
    const { store } = harness([page([commit('aaa1')])])
    await store.loadFirstPage()
    store.setRefs({ zzz9: [{ ref: 'refs/heads/side', name: 'side', kind: 'local', sha: 'zzz9' }] })

    expect(await store.locate('side')).toBe(false)
    expect(jumpText(store)).toContain('不在当前视图')
  })

  it('jumpTo does not flag an error while it is still paging', async () => {
    const { store } = harness([
      page([commit('aaa1', 'bbb2')], 'p2'),
      page([commit('bbb2')]),
    ])
    await store.loadFirstPage()

    expect(store.jumpTo('bbb')).toBe(false)
    expect(store.getState().jumpError).toBeNull()
  })
})

function jumpText(store: LogStore): string | null {
  const value = store.getState().jumpError
  return value === null ? null : render(zhT, value)
}
