// 日志页（设计 §8.1）：筛选栏 + 虚拟化提交图表格 + 可插入的详情区。
// 数据全部来自注入的 LogStore（React-free，见 store/log-store.ts）；页面本身不发 RPC，
// 由宿主（GitBody）创建 store、喂 refs，并通过 renderDetail / onSelect / onOpenCommit 接详情与 diff。
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { CommitSummary, RefEntry } from '../../shared/protocol.ts'
import { DEFAULT_LOG_FILTER } from '../store/log-store.ts'
import type { LogAction, LogState, LogStore } from '../store/log-store.ts'
import { useT } from '../i18n.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { FilterBar, hasActiveFilter } from './FilterBar.tsx'
import type { BranchOption } from './FilterBar.tsx'
import { LogTable } from './LogTable.tsx'
import css from './LogPage.module.css'

/** 当前选择：交给详情区 / 宿主。`commit` 是键盘焦点行（最后点的那行）。 */
export interface LogSelection {
  shas: string[]
  commit: CommitSummary | null
  /** 已加载的选中提交（按表格顺序）。 */
  commits: CommitSummary[]
}

export interface LogPageProps {
  /** `createLogStore({ sessionId, loadPage: (req) => client.log(req) })`，由宿主持有并在卸载时 dispose。 */
  store: LogStore
  /** refs 端点结果（`RefsValue.bySha`）；变化时写进 store，用于胶囊与「跳转到分支/标签」。 */
  refsBySha?: Record<string, RefEntry[]>
  /** HEAD 提交（空心节点）。 */
  headSha?: string | null
  /** 当前本地分支短名（head 色胶囊、当前分支外环）。 */
  currentBranch?: string | null
  /** 分支筛选菜单；省略时从 refsBySha 推导（本地 → 远程 → 标签）。 */
  branchOptions?: readonly BranchOption[]
  /** 用户筛选菜单；省略时从已加载提交的作者累积。 */
  authorOptions?: readonly string[]
  /** 挂载时 store 还没加载过就自动拉第一页（默认 true）。 */
  autoLoad?: boolean
  /** 选择变化（单击、键盘、刷新后恢复）。 */
  onSelect?(selection: LogSelection): void
  /** Enter / 双击：打开该提交的 diff。 */
  onOpenCommit?(commit: CommitSummary): void
  /** Cmd/Ctrl+C：默认写剪贴板（完整哈希，每行一个）。 */
  onCopyHash?(shas: string[]): void
  /** 详情区插槽：Wide 档在右侧，Standard/Compact 档在表格下方。返回 null 时不占位。 */
  renderDetail?(selection: LogSelection): ReactNode
  /** 左侧插槽（分支面板）。 */
  sidebar?: ReactNode
  /** 首帧视口高度（SSR/测试用；运行时以真实尺寸为准）。 */
  viewportHeight?: number
}

/** refs 索引 → 分支筛选选项（去重，本地 → 远程 → 标签，同类按名字排序）。 */
export function branchOptionsFromRefs(bySha: Record<string, RefEntry[]>): BranchOption[] {
  const seen = new Map<string, BranchOption>()
  for (const refs of Object.values(bySha)) {
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.name}`
      if (!seen.has(key)) seen.set(key, { name: ref.name, kind: ref.kind })
    }
  }
  const order = { local: 0, remote: 1, tag: 2 } as const
  return [...seen.values()].sort((left, right) => order[left.kind] - order[right.kind] || left.name.localeCompare(right.name))
}

/** 选择快照（按表格顺序）。 */
export function selectionOf(state: Pick<LogState, 'commits' | 'selection' | 'activeIndex'>): LogSelection {
  const chosen = new Set(state.selection)
  const commits = state.commits.filter((commit) => chosen.has(commit.sha))
  const active = state.commits[state.activeIndex]
  const commit = active !== undefined && chosen.has(active.sha) ? active : commits[commits.length - 1] ?? null
  return { shas: [...state.selection], commit, commits }
}

function defaultCopy(shas: string[]): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  void clipboard?.writeText(shas.join('\n')).catch(() => {})
}

export function LogPage({
  store,
  refsBySha,
  headSha = null,
  currentBranch = null,
  branchOptions,
  authorOptions,
  autoLoad = true,
  onSelect,
  onOpenCommit,
  onCopyHash,
  renderDetail,
  sidebar,
  viewportHeight,
}: LogPageProps): ReactNode {
  const t = useT()
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const rows = store.getRows()
  const searchRef = useRef<HTMLInputElement | null>(null)
  const tableRef = useRef<HTMLDivElement | null>(null)
  const authorsSeen = useRef(new Set<string>())

  useEffect(() => {
    if (refsBySha !== undefined) store.setRefs(refsBySha)
  }, [store, refsBySha])

  useEffect(() => {
    const current = store.getState()
    if (autoLoad && current.generation === 0 && !current.loading) void store.loadFirstPage()
  }, [store, autoLoad])

  const selection = useMemo(() => selectionOf(state), [state])
  const selectionKey = `${selection.shas.join(',')}@${selection.commit?.sha ?? ''}`
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const lastSelectionKey = useRef<string | null>(null)
  useEffect(() => {
    if (lastSelectionKey.current === selectionKey) return
    const first = lastSelectionKey.current === null
    lastSelectionKey.current = selectionKey
    if (first && selection.shas.length === 0) return
    onSelectRef.current?.(selection)
  }, [selectionKey, selection])

  for (const commit of state.commits) authorsSeen.current.add(commit.author)
  for (const author of state.filter.authors) authorsSeen.current.add(author)
  const authors = authorOptions ?? [...authorsSeen.current].sort((left, right) => left.localeCompare(right))
  const branches = useMemo(
    () => branchOptions ?? branchOptionsFromRefs(state.refsBySha),
    [branchOptions, state.refsBySha],
  )

  const focusTable = useCallback(() => { tableRef.current?.focus() }, [])
  const loadNext = useCallback(() => { void store.loadNextPage() }, [store])

  function openActive(): void {
    const commit = store.getState().commits[store.getState().activeIndex]
    if (commit !== undefined) onOpenCommit?.(commit)
  }

  function onAction(action: LogAction): void {
    if (action === 'open-diff') openActive()
    else if (action === 'copy-hash') {
      const shas = selectionOf(store.getState()).commits.map((commit) => commit.sha)
      if (shas.length > 0) (onCopyHash ?? defaultCopy)(shas)
    }
  }

  // 面板级快捷键（§14.1）：Cmd/Ctrl+F 聚焦搜索，Cmd/Ctrl+R 刷新。
  function onPageKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    const key = event.key.toLowerCase()
    if (key === 'f') {
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (key === 'r') {
      event.preventDefault()
      void store.refresh()
    }
  }

  const detail = renderDetail?.(selection) ?? null
  const firstPageError = state.error !== null && state.commits.length === 0
  const pending = state.commits.length === 0 && (state.loading || (state.generation === 0 && state.error === null))

  let content: ReactNode
  if (firstPageError && state.error !== null) {
    content = (
      <EmptyState
        error
        title={t('log.loadFailed')}
        hint={state.error.message}
        action={{ label: t('action.retry'), onClick: () => { void store.refresh() } }}
      />
    )
  } else if (pending) {
    content = (
      <div className={css.skeleton} aria-busy="true" aria-label={t('log.loading')}>
        {Array.from({ length: 8 }, (_, index) => <div key={index} className={css.skeletonRow} />)}
      </div>
    )
  } else if (state.commits.length === 0) {
    content = hasActiveFilter(state.filter)
      ? (
        <EmptyState
          title={t('log.noMatch.title')}
          hint={t('log.noMatch.hint')}
          action={{ label: t('log.clearFilters'), onClick: () => store.setFilter({ ...DEFAULT_LOG_FILTER }) }}
        />
      )
      : <EmptyState title={t('log.empty.title')} hint={t('log.empty.hint')} />
  } else {
    content = (
      <LogTable
        rows={rows}
        selection={state.selection}
        activeIndex={state.activeIndex}
        generation={state.generation}
        headSha={headSha}
        currentBranch={currentBranch}
        loadingMore={state.loadingMore}
        atRowLimit={state.atRowLimit}
        onRowClick={(index, modifiers) => store.selectIndex(index, modifiers)}
        onRowOpen={(index) => {
          store.selectIndex(index)
          openActive()
        }}
        onKey={store.handleKey}
        onAction={onAction}
        onNearEnd={loadNext}
        footerError={state.error === null ? null : { message: state.error.message, onRetry: loadNext }}
        tableRef={tableRef}
        viewportHeight={viewportHeight}
      />
    )
  }

  return (
    <div className={css.page} onKeyDown={onPageKey} data-log-page="">
      <FilterBar
        query={state.query}
        filter={state.filter}
        branchOptions={branches}
        authorOptions={authors}
        jumpError={state.jumpError}
        searchRef={searchRef}
        onQueryChange={store.setQuery}
        onQueryCommit={store.commitQuery}
        onQueryClear={store.clearSearch}
        onFilterChange={store.setFilter}
        onJump={store.jumpTo}
        onJumpEdit={store.clearJumpError}
        onRefresh={() => { void store.refresh() }}
        onLeave={focusTable}
      />
      <div className={css.body}>
        {sidebar === undefined || sidebar === null ? null : <div className={css.sidebar}>{sidebar}</div>}
        <div className={css.main}>{content}</div>
        {detail === null ? null : <div className={css.detail} data-log-detail="">{detail}</div>}
      </div>
    </div>
  )
}
