// 日志页状态（设计 §8.1）：分页追加、筛选重建、选择与键盘。
// React-free：LogPage 用 useSyncExternalStore 订阅，测试直接驱动，不需要 DOM。
import type {
  CommitSummary,
  GitError,
  LogRequest,
  LogValue,
  RefEntry,
  RpcResult,
} from '../../shared/protocol.ts'
import { LOG_PAGE_MAX_LIMIT } from '../../shared/protocol.ts'
import { createGraphLayout } from '../graph/layout.ts'
import type { GraphLayout, GraphRow } from '../graph/layout.ts'

/** 每页 100 条（设计 §8.1.3）。 */
export const LOG_PAGE_SIZE = 100

/** 最多保留 2000 行，超出提示「继续加载」（设计 §8.1.3）。 */
export const LOG_MAX_ROWS = 2000

/** 搜索防抖 600ms（设计 §8.1.2）。 */
export const LOG_SEARCH_DEBOUNCE_MS = 600

export type LogOrder = 'date' | 'topo'

/** 影响 Host 侧 `git log` 参数的全部筛选条件（AC4：筛选在 Host 执行）。 */
export interface LogFilterState {
  /** 已生效的搜索文本（消息/作者/哈希）。 */
  query: string
  /** 按正则解释 query（`.*` 按钮）。 */
  regex: boolean
  /** 区分大小写（`Aa` 按钮）。 */
  caseSensitive: boolean
  /** 分支过滤（ref 名，多选）。 */
  branches: string[]
  /** 作者过滤（多选）。 */
  authors: string[]
  /** 排序：日期 / 拓扑。 */
  order: LogOrder
  /** 仅第一父提交。 */
  firstParent: boolean
  /** 隐藏合并提交。 */
  noMerges: boolean
}

export const DEFAULT_LOG_FILTER: LogFilterState = {
  query: '',
  regex: false,
  caseSensitive: false,
  branches: [],
  authors: [],
  order: 'date',
  firstParent: false,
  noMerges: false,
}

/** 键盘需要交给页面处理的动作（表格不自己开 diff / 复制）。 */
export type LogAction = 'open-diff' | 'clear-search' | 'copy-hash' | 'select-all'

export interface LogKeyInput {
  /** `KeyboardEvent.key`（`a` / `ArrowDown` …）。 */
  key: string
  shiftKey?: boolean
  /** Cmd / Ctrl。 */
  primary?: boolean
}

export interface LogKeyResult {
  handled: boolean
  action?: LogAction
  /** 导航到子/父提交后的目标行。 */
  targetIndex?: number
}

export interface LogSelectModifiers {
  /** Shift：从锚点连选。 */
  shift?: boolean
  /** Cmd/Ctrl：切换单行。 */
  toggle?: boolean
}

/** 一行表格数据：提交 + 图形行 + 指向它的 refs。 */
export interface LogTableData {
  commit: CommitSummary
  graph: GraphRow
  refs: RefEntry[]
}

export interface LogState {
  sessionId: string
  /** 输入框原文（防抖生效前）。 */
  query: string
  filter: LogFilterState
  commits: CommitSummary[]
  /** 与 commits 一一对应（索引对齐）。 */
  rows: GraphRow[]
  refsBySha: Record<string, RefEntry[]>
  loading: boolean
  loadingMore: boolean
  error: GitError | null
  /** 下一页游标；没有更多时 undefined。 */
  next: string | undefined
  truncated: boolean
  /** 选中的 sha（按点击顺序）。 */
  selection: string[]
  /** Shift 连选的锚点行。 */
  anchorIndex: number
  /** 键盘焦点行。 */
  activeIndex: number
  /** 筛选/排序重建计数：表格据此回到顶部（AC4）。 */
  generation: number
  jumpError: string | null
  /** 已加载到 2000 行上限，不再自动加载。 */
  atRowLimit: boolean
}

export interface LogStoreOptions {
  sessionId: string
  /** 真正发 RPC 的函数（由 Lead 接线到 git-client）。 */
  loadPage(request: LogRequest): Promise<RpcResult<LogValue>>
  pageSize?: number
  maxRows?: number
  debounceMs?: number
}

export interface LogStore {
  getState(): LogState
  subscribe(listener: () => void): () => void
  /** 表格数据（commits + 图形 + refs）；输入不变时返回同一个数组引用。 */
  getRows(): LogTableData[]
  /** 首屏：重建布局后拉第一页。 */
  loadFirstPage(): Promise<void>
  /** 滚动接近底部时追加下一页；并发/到顶/到上限时自行忽略。 */
  loadNextPage(): Promise<void>
  /** 重新拉第一页，保留筛选与已选中项（刷新用）。 */
  refresh(): Promise<void>
  /** 输入框变化：立即更新原文，600ms 后应用。 */
  setQuery(raw: string): void
  /** Enter：立即应用当前输入。 */
  commitQuery(): void
  /** Esc：清空搜索并立即应用。 */
  clearSearch(): void
  /** 分支/用户/图选项变化：重建布局并回到第一页。 */
  setFilter(patch: Partial<LogFilterState>): void
  setRefs(bySha: Record<string, RefEntry[]>): void
  selectIndex(index: number, modifiers?: LogSelectModifiers): void
  selectAll(): void
  handleKey(input: LogKeyInput): LogKeyResult
  /** 跳转到哈希/分支/标签；失败时设置 jumpError 并返回 false。 */
  jumpTo(input: string): boolean
  clearJumpError(): void
  dispose(): void
}

export function createLogStore(options: LogStoreOptions): LogStore {
  const pageSize = Math.min(LOG_PAGE_MAX_LIMIT, Math.max(1, Math.trunc(options.pageSize ?? LOG_PAGE_SIZE)))
  const maxRows = Math.max(pageSize, Math.trunc(options.maxRows ?? LOG_MAX_ROWS))
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? LOG_SEARCH_DEBOUNCE_MS))

  let state: LogState = {
    sessionId: options.sessionId,
    query: '',
    filter: DEFAULT_LOG_FILTER,
    commits: [],
    rows: [],
    refsBySha: {},
    loading: false,
    loadingMore: false,
    error: null,
    next: undefined,
    truncated: false,
    selection: [],
    anchorIndex: -1,
    activeIndex: -1,
    generation: 0,
    jumpError: null,
    atRowLimit: false,
  }
  let layout: GraphLayout = createGraphLayout()
  const listeners = new Set<() => void>()
  let requestSeq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let seen = new Set<string>()
  let rowsCache: { commits: CommitSummary[]; rows: GraphRow[]; refsBySha: Record<string, RefEntry[]>; value: LogTableData[] } | null = null

  function setState(patch: Partial<LogState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function layoutOptions(): { order: LogOrder; firstParent: boolean; noMerges: boolean } {
    return {
      order: state.filter.order,
      firstParent: state.filter.firstParent,
      noMerges: state.filter.noMerges,
    }
  }

  function toRequest(cursor: string | undefined): LogRequest {
    const filter = state.filter
    const request: LogRequest = {
      sessionId: options.sessionId,
      limit: pageSize,
      order: filter.order,
    }
    if (filter.query.length > 0) {
      request.query = filter.query
      request.regex = filter.regex
      request.caseSensitive = filter.caseSensitive
    }
    if (filter.branches.length > 0) request.branches = [...filter.branches]
    if (filter.authors.length > 0) request.authors = [...filter.authors]
    if (filter.firstParent) request.firstParent = true
    if (filter.noMerges) request.noMerges = true
    if (cursor !== undefined) request.cursor = cursor
    return request
  }

  async function fetchPage(cursor: string | undefined): Promise<RpcResult<LogValue>> {
    try {
      return await options.loadPage(toRequest(cursor))
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'git/exec-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /**
   * 把一页结果并入 layout：跨页去重，并遵守 2000 行上限。
   * `replace` 用于首页：以空列表为基底（刷新时旧行一直显示到新结果到达，再整体替换）。
   */
  function integrate(value: LogValue, replace: boolean): void {
    const baseCommits = replace ? [] : state.commits
    const baseRows = replace ? [] : state.rows
    const capacity = Math.max(0, maxRows - baseCommits.length)
    const fresh: CommitSummary[] = []
    for (const commit of value.commits) {
      if (seen.has(commit.sha)) continue
      if (fresh.length >= capacity) break
      seen.add(commit.sha)
      fresh.push(commit)
    }
    const appended = layout.append(
      fresh.map((commit) => ({ sha: commit.sha, parents: commit.parents })),
      { hasMore: value.next !== undefined },
    )
    const next = value.next
    const commits = fresh.length === 0 ? baseCommits : [...baseCommits, ...fresh]
    setState({
      commits,
      rows: fresh.length === 0 ? baseRows : [...baseRows, ...appended],
      next,
      truncated: value.truncated,
      atRowLimit: next !== undefined && commits.length >= maxRows,
    })
  }

  /** reset=false 时保留选中（刷新），否则清空选中并回到顶部。 */
  async function load(reset: boolean): Promise<void> {
    const seq = ++requestSeq
    layout = createGraphLayout(layoutOptions())
    seen = new Set()
    const keptSelection = reset ? [] : state.selection
    const keptActive = reset ? -1 : state.activeIndex
    setState({
      loading: true,
      loadingMore: false,
      error: null,
      next: undefined,
      truncated: false,
      atRowLimit: false,
      ...(reset
        ? { commits: [], rows: [], selection: [], anchorIndex: -1, activeIndex: -1, generation: state.generation + 1 }
        : { activeIndex: keptActive, selection: keptSelection }),
    })

    const result = await fetchPage(undefined)
    if (seq !== requestSeq) return
    if (!result.ok) {
      setState({ loading: false, error: result.error })
      return
    }
    setState({ loading: false })
    integrate(result.value, true)
    if (!reset && keptSelection.length > 0) restoreSelection(keptSelection)
  }

  /** 刷新后把还存在的选中项找回来。 */
  function restoreSelection(shas: string[]): void {
    const selection = shas.filter((sha) => state.commits.some((commit) => commit.sha === sha))
    const activeSha = selection[selection.length - 1]
    const activeIndex = activeSha === undefined
      ? -1
      : state.commits.findIndex((commit) => commit.sha === activeSha)
    setState({ selection, activeIndex, anchorIndex: activeIndex })
  }

  function applyQuery(query: string): void {
    if (query === state.filter.query) return
    const filter: LogFilterState = { ...state.filter, query }
    setState({ filter })
    void load(true)
  }

  function cancelDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  function selectionRange(from: number, to: number): string[] {
    const start = Math.max(0, Math.min(from, to))
    const end = Math.min(state.commits.length - 1, Math.max(from, to))
    const shas: string[] = []
    for (let index = start; index <= end; index += 1) {
      const commit = state.commits[index]
      if (commit !== undefined) shas.push(commit.sha)
    }
    return shas
  }

  function selectIndex(index: number, modifiers: LogSelectModifiers = {}): void {
    const commit = state.commits[index]
    if (commit === undefined) return
    if (modifiers.shift === true && state.anchorIndex >= 0) {
      // Shift：从锚点连选，锚点保持不动。
      setState({ selection: selectionRange(state.anchorIndex, index), activeIndex: index })
      return
    }
    if (modifiers.toggle === true) {
      const selected = state.selection.includes(commit.sha)
      const selection = selected
        ? state.selection.filter((sha) => sha !== commit.sha)
        : [...state.selection, commit.sha]
      setState({ selection, activeIndex: index, anchorIndex: index })
      return
    }
    setState({ selection: [commit.sha], activeIndex: index, anchorIndex: index })
  }

  function selectAllRows(): void {
    setState({
      selection: state.commits.map((commit) => commit.sha),
      anchorIndex: 0,
      activeIndex: state.commits.length - 1,
    })
  }

  function clearSearchNow(): void {
    cancelDebounce()
    setState({ query: '' })
    applyQuery('')
  }

  /** 键盘上下移动；shift 时扩展多选。 */
  function moveActive(index: number, shift: boolean): void {
    if (state.commits.length === 0) return
    const clamped = Math.max(0, Math.min(state.commits.length - 1, index))
    if (shift) {
      const anchor = state.anchorIndex >= 0 ? state.anchorIndex : clamped
      setState({ selection: selectionRange(anchor, clamped), activeIndex: clamped, anchorIndex: anchor })
      return
    }
    selectIndex(clamped)
  }

  /** ← / → 跳到子 / 父提交（设计 §14.1 的表格顺序：左为子，右为父）。 */
  function navigate(relation: 'child' | 'parent'): LogKeyResult {
    const active = state.commits[state.activeIndex]
    if (active === undefined) return { handled: false }
    const parentSha = active.parents[0]
    const targetIndex = relation === 'parent'
      ? parentSha === undefined
        ? -1
        : state.commits.findIndex((commit) => commit.sha === parentSha)
      : state.commits.findIndex((commit) => commit.parents.includes(active.sha))
    if (targetIndex < 0) return { handled: true }
    selectIndex(targetIndex)
    return { handled: true, targetIndex }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getRows() {
      const cached = rowsCache
      if (cached !== null && cached.commits === state.commits && cached.rows === state.rows && cached.refsBySha === state.refsBySha) {
        return cached.value
      }
      const value: LogTableData[] = state.commits.map((commit, index) => ({
        commit,
        graph: state.rows[index] ?? { sha: commit.sha, lane: 0, colorId: 0, edges: [], width: 1 },
        refs: state.refsBySha[commit.sha] ?? [],
      }))
      rowsCache = { commits: state.commits, rows: state.rows, refsBySha: state.refsBySha, value }
      return value
    },
    async loadFirstPage() {
      await load(true)
    },
    async loadNextPage() {
      if (state.loading || state.loadingMore) return
      if (state.next === undefined || state.atRowLimit) return
      const seq = requestSeq
      // 重试下一页时先清掉上一次的失败提示。
      setState({ loadingMore: true, error: null })
      const result = await fetchPage(state.next)
      if (seq !== requestSeq) return
      if (!result.ok) {
        setState({ loadingMore: false, error: result.error })
        return
      }
      setState({ loadingMore: false })
      integrate(result.value, false)
    },
    async refresh() {
      await load(false)
    },
    setQuery(raw) {
      setState({ query: raw })
      cancelDebounce()
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        applyQuery(raw)
      }, debounceMs)
    },
    commitQuery() {
      cancelDebounce()
      applyQuery(state.query)
    },
    clearSearch: clearSearchNow,
    setFilter(patch) {
      const filter: LogFilterState = { ...state.filter, ...patch }
      if (isSameFilter(filter, state.filter)) return
      cancelDebounce()
      setState({ filter, ...(patch.query === undefined ? {} : { query: patch.query }), jumpError: null })
      void load(true)
    },
    setRefs(bySha) {
      setState({ refsBySha: bySha })
    },
    selectIndex,
    selectAll: selectAllRows,
    handleKey(input) {
      const primary = input.primary === true
      const count = state.commits.length
      if (primary && input.key.toLowerCase() === 'a') {
        selectAllRows()
        return { handled: true, action: 'select-all' }
      }
      if (primary && input.key.toLowerCase() === 'c') {
        return { handled: state.selection.length > 0, action: 'copy-hash' }
      }
      switch (input.key) {
        case 'ArrowUp':
          if (count === 0) return { handled: false }
          moveActive(state.activeIndex < 0 ? 0 : state.activeIndex - 1, input.shiftKey === true)
          return { handled: true }
        case 'ArrowDown':
          if (count === 0) return { handled: false }
          moveActive(state.activeIndex < 0 ? 0 : state.activeIndex + 1, input.shiftKey === true)
          return { handled: true }
        case 'PageUp':
          if (count === 0) return { handled: false }
          moveActive((state.activeIndex < 0 ? 0 : state.activeIndex) - pageSize, input.shiftKey === true)
          return { handled: true }
        case 'PageDown':
          if (count === 0) return { handled: false }
          moveActive((state.activeIndex < 0 ? 0 : state.activeIndex) + pageSize, input.shiftKey === true)
          return { handled: true }
        case 'Home':
          if (count === 0) return { handled: false }
          moveActive(0, input.shiftKey === true)
          return { handled: true }
        case 'End':
          if (count === 0) return { handled: false }
          moveActive(count - 1, input.shiftKey === true)
          return { handled: true }
        case 'ArrowLeft':
          return navigate('child')
        case 'ArrowRight':
          return navigate('parent')
        case 'Enter':
          return state.activeIndex < 0 ? { handled: false } : { handled: true, action: 'open-diff' }
        case 'Escape':
          if (state.query.length > 0 || state.filter.query.length > 0) {
            clearSearchNow()
            return { handled: true, action: 'clear-search' }
          }
          return { handled: false }
        default:
          return { handled: false }
      }
    },
    jumpTo(input) {
      const target = input.trim()
      if (target.length === 0) {
        setState({ jumpError: '请输入哈希、分支或标签' })
        return false
      }
      const lowered = target.toLowerCase()
      const bySha = state.commits.findIndex((commit) => commit.sha.toLowerCase().startsWith(lowered))
      if (bySha >= 0) {
        setState({ jumpError: null })
        selectIndex(bySha)
        return true
      }
      const refSha = findRefSha(state.refsBySha, lowered)
      if (refSha !== null) {
        const index = state.commits.findIndex((commit) => commit.sha === refSha)
        if (index >= 0) {
          setState({ jumpError: null })
          selectIndex(index)
          return true
        }
      }
      setState({ jumpError: `未找到「${target}」` })
      return false
    },
    clearJumpError() {
      if (state.jumpError !== null) setState({ jumpError: null })
    },
    dispose() {
      cancelDebounce()
      requestSeq += 1
      listeners.clear()
    },
  }
}

/** 在 refs 索引里按短名或完整 ref 名找一个 sha。 */
export function findRefSha(bySha: Record<string, RefEntry[]>, target: string): string | null {
  for (const [sha, refs] of Object.entries(bySha)) {
    for (const ref of refs) {
      const name = ref.name.toLowerCase()
      const full = ref.ref.toLowerCase()
      if (name === target || full === target || full === `refs/heads/${target}` || full === `refs/tags/${target}` || full === `refs/remotes/${target}`) {
        return sha
      }
    }
  }
  return null
}

function isSameFilter(left: LogFilterState, right: LogFilterState): boolean {
  return left.query === right.query
    && left.regex === right.regex
    && left.caseSensitive === right.caseSensitive
    && left.order === right.order
    && left.firstParent === right.firstParent
    && left.noMerges === right.noMerges
    && sameList(left.branches, right.branches)
    && sameList(left.authors, right.authors)
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
