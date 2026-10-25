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
export function detailActionFor(selection: LogSelection, currentSha: string | null): DetailAction {
  const sha = selection.commit?.sha
  if (sha !== undefined) return sha === currentSha ? { kind: 'keep' } : { kind: 'select', sha }
  if (selection.shas.length === 0 && currentSha !== null) return { kind: 'clear' }
  return { kind: 'keep' }
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

  const loadSideData = useCallback(async (): Promise<void> => {
    branchesStore.setLoading(true)
    const [refs, branchList] = await Promise.all([client.refs(sessionId), client.branches(sessionId)])
    if (refs.ok) setRefsBySha(refs.value.bySha)
    if (branchList.ok) {
      branchesStore.setValue(branchList.value)
      branchesStore.setError(null)
    } else {
      branchesStore.setError(branchList.error)
    }
    branchesStore.setLoading(false)
  }, [branchesStore, client, sessionId])

  // 首次挂载拉 refs/分支；之后仓库 version 变化时，日志与侧栏一起刷新（保留筛选与选中）。
  const seenVersion = useRef<number | null>(null)
  useEffect(() => {
    if (seenVersion.current === value.version) return
    const first = seenVersion.current === null
    seenVersion.current = value.version
    void loadSideData()
    if (!first) void logStore.refresh()
  }, [loadSideData, logStore, value.version])

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

  const onSelect = useCallback((selection: LogSelection) => {
    const action = detailActionFor(selection, detailStore.getState().sha)
    if (action.kind === 'keep') return
    setSelectedFile(undefined)
    if (action.kind === 'clear') detailStore.cancel()
    else void detailStore.select(action.sha)
  }, [detailStore])

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
      onNavigate={entry => { navigateTo(entry.sha) }}
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
        lastRefreshAt={props.lastRefreshAt}
        autoRefresh={props.autoRefresh}
        onToggleAutoRefresh={props.onToggleAutoRefresh}
      />
    </div>
  )
}
