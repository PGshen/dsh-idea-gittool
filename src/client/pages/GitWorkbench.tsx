// Git tab 的 A1 工作台：把日志页、分支面板、提交详情、Diff 覆盖层、状态栏与控制台接到一起。
// 各页面与 store 都是注入式的；这里只负责创建 store、发 RPC、在版本变化时刷新，以及页面间导航。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  BootstrapValue,
  CommitDetailValue,
  CommitFileEntry,
  CommitSummary,
  DiffRequest,
  RefEntry,
} from '../../shared/protocol.ts'
import { ConsoleDrawer, CONSOLE_DEFAULT_HEIGHT } from '../console/ConsoleDrawer.tsx'
import { createConsoleStore, useConsoleState } from '../console/console-store.ts'
import type { GitClient } from '../git-client.ts'
import { ReadOnlyBanner } from '../read-only-banner.tsx'
import { createDetailStore, useDetailState } from '../store/detail-store.ts'
import { createLogStore } from '../store/log-store.ts'
import { BranchPanel } from './BranchPanel.tsx'
import { createBranchesStore, useBranchesState } from './branch-store.ts'
import { CommitDetail } from './CommitDetail.tsx'
import { DiffViewer } from './DiffViewer.tsx'
import css from './GitWorkbench.module.css'
import { LogPage } from './LogPage.tsx'
import type { LogSelection } from './LogPage.tsx'
import { OperationBanner, bannerFromStatus } from './OperationBanner.tsx'
import { RepoBar } from './RepoBar.tsx'
import { StatusBar } from './StatusBar.tsx'

export interface GitWorkbenchProps {
  sessionId: string
  client: GitClient
  /** 最新的 bootstrap 快照；version 变化时刷新日志/refs/分支。 */
  value: BootstrapValue
  /** 手动刷新 bootstrap（状态栏、仓库栏的刷新入口）。 */
  onRefresh: () => Promise<unknown>
  autoRefresh: boolean
  onToggleAutoRefresh: () => void
  /** 最近一次成功刷新的时间（ms）。 */
  lastRefreshAt: number | null
}

interface OpenDiff {
  request: DiffRequest
  files: CommitFileEntry[]
  source: string[]
}

/** 合并提交把各父分组展开成一份文件列表（条目带 parentSha）；普通提交直接用 files。 */
export function diffFilesOf(detail: CommitDetailValue): CommitFileEntry[] {
  if (detail.parentGroups === undefined) return detail.files
  return detail.parentGroups.flatMap(group => group.files.map(file => ({ ...file, parentSha: group.parentSha })))
}

export type DetailAction = { kind: 'select'; sha: string } | { kind: 'clear' } | { kind: 'keep' }

/**
 * 日志选择 → 详情动作。多选时详情跟随焦点行；选中被筛选/重建清空时清掉详情，
 * 否则详情会停留在已不在列表里的提交上。
 */
export function detailActionFor(
  selection: LogSelection,
  currentSha: string | null,
  /** 选中是被筛选/排序重建清空的（log generation 变化）；刷新清空时保留正在看的详情。 */
  filterReset = true,
): DetailAction {
  const sha = selection.commit?.sha
  if (sha !== undefined) return sha === currentSha ? { kind: 'keep' } : { kind: 'select', sha }
  if (selection.shas.length === 0 && currentSha !== null && filterReset) return { kind: 'clear' }
  return { kind: 'keep' }
}

/**
 * 日志是否需要随仓库变化刷新：只看 HEAD 与 refs（评审 I3）。
 * watch 也会因 `.git/index`（暂存、Agent 的 git add）递增 version，那类变化不影响历史，
 * 不该把用户正在浏览的日志重拉一遍。
 */
export function logRefreshKey(head: string | null | undefined, refsBySha: Record<string, RefEntry[]> | undefined): string {
  const refs = Object.values(refsBySha ?? {})
    .flat()
    .map(entry => `${entry.ref}=${entry.sha}`)
    .sort()
  return `${head ?? ''}|${refs.join(',')}`
}

export function GitWorkbench(props: GitWorkbenchProps): ReactNode {
  const { sessionId, client, value, onRefresh } = props
  const status = value.status

  const logStore = useMemo(
    () => createLogStore({ sessionId, loadPage: request => client.log(request) }),
    [client, sessionId],
  )
  const detailStore = useMemo(
    () => createDetailStore({ load: (sha, signal) => client.commit({ sessionId, sha }, signal) }),
    [client, sessionId],
  )
  const branchesStore = useMemo(() => createBranchesStore(), [sessionId])
  const consoleStore = useMemo(
    () => createConsoleStore({ load: signal => client.console(sessionId, signal) }),
    [client, sessionId],
  )
  useEffect(() => () => { logStore.dispose() }, [logStore])
  useEffect(() => () => { detailStore.cancel() }, [detailStore])
  useEffect(() => () => { consoleStore.reset() }, [consoleStore])

  const detail = useDetailState(detailStore)
  const branches = useBranchesState(branchesStore)
  const consoleState = useConsoleState(consoleStore)

  const [refsBySha, setRefsBySha] = useState<Record<string, RefEntry[]> | undefined>(undefined)
  const [diff, setDiff] = useState<OpenDiff | null>(null)
  const [selectedFile, setSelectedFile] = useState<{ path: string; parentSha?: string } | undefined>(undefined)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleHeight, setConsoleHeight] = useState(CONSOLE_DEFAULT_HEIGHT)
  const [refreshing, setRefreshing] = useState(false)

  // 侧栏数据请求序号：并发时只采用最后一次发出的结果，卸载后不再写状态（评审 M1）。
  const sideSeq = useRef(0)
  useEffect(() => () => { sideSeq.current += 1 }, [])
  const loadSideData = useCallback(async (): Promise<Record<string, RefEntry[]> | undefined> => {
    const seq = ++sideSeq.current
    branchesStore.setLoading(true)
    const [refs, branchList] = await Promise.all([client.refs(sessionId), client.branches(sessionId)])
    if (seq !== sideSeq.current) return undefined
    if (refs.ok) setRefsBySha(refs.value.bySha)
    if (branchList.ok) {
      branchesStore.setValue(branchList.value)
      branchesStore.setError(null)
    } else {
      branchesStore.setError(branchList.error)
    }
    branchesStore.setLoading(false)
    return refs.ok ? refs.value.bySha : undefined
  }, [branchesStore, client, sessionId])

  // 首次挂载拉 refs/分支；之后仓库 version 变化时刷新侧栏，HEAD 或 refs 真的变了才刷新日志。
  const seenVersion = useRef<number | null>(null)
  const lastLogKey = useRef<string | null>(null)
  const head = status?.head ?? null
  useEffect(() => {
    if (seenVersion.current === value.version) return
    seenVersion.current = value.version
    // 抽屉关着也拉一次，仓库栏「⋯」上的失败提示点才能及时亮起（评审 M2）。
    void consoleStore.refresh()
    void loadSideData().then(refs => {
      if (refs === undefined) return
      const key = logRefreshKey(head, refs)
      const first = lastLogKey.current === null
      if (key === lastLogKey.current) return
      lastLogKey.current = key
      if (!first) void logStore.refresh()
    })
  }, [consoleStore, head, loadSideData, logStore, value.version])

  const refreshAll = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await Promise.all([onRefresh(), logStore.refresh(), loadSideData(), consoleOpen ? consoleStore.refresh() : undefined])
    } finally {
      setRefreshing(false)
    }
  }, [consoleOpen, consoleStore, loadSideData, logStore, onRefresh])

  // 档位跟随 Git tab 内容区宽度（Wide ≥1000 / Standard 600–999 / Compact <600）。
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = rootRef.current
    if (element === null) return
    // 挂载时先同步量一次：ResizeObserver 的首次通知在后台/隐藏页可能迟迟不到，档位会卡在初值。
    const initial = element.getBoundingClientRect().width
    if (initial > 0) branchesStore.setWidth(initial)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      // 隐藏时宽度为 0，保持上一个档位，等重新可见再更新。
      if (width !== undefined && width > 0) branchesStore.setWidth(width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [branchesStore])

  useEffect(() => {
    if (!consoleOpen) return
    consoleStore.start()
    return () => { consoleStore.stop() }
  }, [consoleOpen, consoleStore])

  const lastGeneration = useRef(logStore.getState().generation)
  const onSelect = useCallback((selection: LogSelection) => {
    const generation = logStore.getState().generation
    const filterReset = generation !== lastGeneration.current
    lastGeneration.current = generation
    const action = detailActionFor(selection, detailStore.getState().sha, filterReset)
    if (action.kind === 'keep') return
    setSelectedFile(undefined)
    if (action.kind === 'clear') detailStore.cancel()
    else void detailStore.select(action.sha)
  }, [detailStore, logStore])

  const openFile = useCallback((commit: CommitDetailValue, file: CommitFileEntry, parentSha?: string) => {
    const parent = parentSha ?? file.parentSha
    setSelectedFile(parent === undefined ? { path: file.path } : { path: file.path, parentSha: parent })
    setDiff({
      request: {
        sessionId,
        scope: 'commit',
        sha: commit.sha,
        path: file.path,
        ...(parent === undefined ? {} : { parent }),
      },
      files: diffFilesOf(commit),
      source: ['日志', commit.shortSha],
    })
  }, [sessionId])

  const onOpenCommit = useCallback((commit: CommitSummary) => {
    // Enter/双击：打开该提交的第一个变更文件；详情未就绪时先加载。
    const openFirst = (): void => {
      const loaded = detailStore.getState().value
      if (loaded === null || loaded.sha !== commit.sha) return
      const first = diffFilesOf(loaded)[0]
      if (first !== undefined) openFile(loaded, first)
    }
    if (detailStore.getState().value?.sha === commit.sha) openFirst()
    else void detailStore.select(commit.sha).then(openFirst)
  }, [detailStore, openFile])

  const navigateTo = useCallback((sha: string) => {
    logStore.jumpTo(sha)
  }, [logStore])

  const renderDetail = useCallback(() => (
    detail.status === 'idle' ? null : (
      <CommitDetail
        detail={detail.value}
        status={detail.status}
        error={detail.error}
        {...(selectedFile === undefined ? {} : { selectedFile })}
        onOpenFile={(file, parentSha) => {
          if (detail.value !== null) openFile(detail.value, file, parentSha)
        }}
        onNavigate={navigateTo}
        onRetry={() => { void detailStore.reload() }}
      />
    )
  ), [detail, detailStore, navigateTo, openFile, selectedFile])

  const branchPanel = (
    <BranchPanel
      value={branches.value}
      mode={branches.mode}
      open={branches.open}
      search={branches.search}
      collapsedGroups={branches.collapsedGroups}
      collapsedDirs={branches.collapsedDirs}
      flat={branches.flat}
      loading={branches.loading}
      error={branches.error}
      collapsed={branches.wideCollapsed}
      // 传完整 ref 名：目标不在当前视图时，跳转失败提示可以建议「双击过滤到该分支」。
      onNavigate={entry => { navigateTo(entry.ref === 'HEAD' ? entry.sha : entry.ref) }}
      onFilter={entry => { logStore.setFilter({ branches: [entry.name] }) }}
      onClose={() => { branchesStore.setOpen(false) }}
      onToggleCollapse={() => { branchesStore.setWideCollapsed(!branches.wideCollapsed) }}
      onSearchChange={search => { branchesStore.setSearch(search) }}
      onToggleGroup={kind => { branchesStore.toggleGroup(kind) }}
      onToggleDirectory={path => { branchesStore.toggleDirectory(path) }}
      onToggleFlat={() => { branchesStore.setFlat(!branches.flat) }}
      onRetry={() => { void loadSideData() }}
      onOpenConsole={() => { setConsoleOpen(true) }}
    />
  )
  const wide = branches.mode === 'wide'

  return (
    <div ref={rootRef} className={css.root} data-dsh-git-workbench="" data-mode={branches.mode}>
      <ReadOnlyBanner policy={value.writePolicy} />
      <OperationBanner {...bannerFromStatus(status)} onOpenConsole={() => { setConsoleOpen(true) }} />
      <RepoBar
        repoRoot={value.repoRoot}
        refreshing={refreshing}
        mode={branches.mode}
        branchesOpen={branches.open}
        consoleHasErrors={consoleState.failedCount > 0}
        onRefresh={() => { void refreshAll() }}
        onOpenConsole={() => { setConsoleOpen(true) }}
        onToggleBranches={() => { branchesStore.setOpen(!branches.open) }}
      />
      <div className={css.content}>
        <LogPage
          store={logStore}
          {...(refsBySha === undefined ? {} : { refsBySha })}
          headSha={status?.head ?? null}
          currentBranch={status?.branch ?? null}
          onSelect={onSelect}
          onOpenCommit={onOpenCommit}
          renderDetail={renderDetail}
          {...(wide ? { sidebar: branchPanel } : {})}
        />
        {wide ? null : branchPanel}
        {diff === null ? null : (
          <DiffViewer
            request={diff.request}
            load={(request, signal) => client.diff(request, signal)}
            files={diff.files}
            source={diff.source}
            onSwitchFile={(request, file) => {
              setSelectedFile(request.parent === undefined
                ? { path: file.path }
                : { path: file.path, parentSha: request.parent })
            }}
            onClose={() => { setDiff(null) }}
          />
        )}
      </div>
      {consoleOpen ? (
        <ConsoleDrawer
          state={consoleState}
          height={consoleHeight}
          fullHeight={branches.mode === 'compact'}
          onHeightChange={setConsoleHeight}
          onClose={() => { setConsoleOpen(false) }}
          onClear={() => { consoleStore.clear() }}
          onPausedChange={paused => { consoleStore.setPaused(paused) }}
          onToggleExpanded={key => { consoleStore.toggleExpanded(key) }}
          onRetry={() => { void consoleStore.refresh() }}
        />
      ) : null}
      <StatusBar
        status={status}
        stashCount={status?.stashCount ?? null}
        gitVersion={value.gitVersion ?? null}
        lastRefreshAt={props.lastRefreshAt}
        autoRefresh={props.autoRefresh}
        onToggleAutoRefresh={props.onToggleAutoRefresh}
      />
    </div>
  )
}
