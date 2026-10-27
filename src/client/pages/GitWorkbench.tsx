// Git tab 的工作台：A1 的日志页、分支面板、提交详情、Diff 覆盖层、状态栏与控制台，
// A2 的提交页（变更树 + 提交信息）、Push / Push Rejected 覆盖页与回滚确认。
// 各页面与 store 都是注入式的；这里只负责创建 store、发 RPC、在版本变化时刷新，以及页面间导航。
// A3 T6：覆盖层只有一个槽位（workbench-overlay），写动作统一经 action store（`actions.run`）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  BootstrapValue,
  CommitDetailValue,
  CommitFileEntry,
  CommitResultValue,
  CommitSummary,
  FileEntry,
  RefEntry,
  StatusValue,
} from '../../shared/protocol.ts'
import { ConsoleDrawer, CONSOLE_DEFAULT_HEIGHT } from '../console/ConsoleDrawer.tsx'
import { createConsoleStore, useConsoleState } from '../console/console-store.ts'
import type { GitClient } from '../git-client.ts'
import { newRequestId } from '../git-client.ts'
import { createStashStore } from '../store/stash-store.ts'
import { createActionStore, useActionState } from '../store/action-store.ts'
import type { ActionOutcome } from '../store/action-store.ts'
import { createChangesStore, uncommittedCount, useChangesState } from '../store/changes-store.ts'
import { commitPageModeOf, createCommitStore, useCommitState, visibleMessage } from '../store/commit-store.ts'
import type { CommitPhase } from '../store/commit-store.ts'
import { conflictListSync, createAutoOpenTracker, createConflictStore, operationIdentity, useConflictState } from '../store/conflict-store.ts'
import type { OperationControlAction } from '../../shared/protocol.ts'
import { ConflictsPage } from './ConflictsPage.tsx'
import { isFeatureEnabled } from '../features.ts'
import { createMergeStore } from '../store/merge-store.ts'
import { MergeWindow } from './MergeWindow.tsx'
import type { SidebarFullscreen } from './merge-fullscreen.ts'
import { createMergeReviewWiring } from './merge-review-wiring.ts'
import { controlOperation, mergePrefill, operationBusy, operationOutcomeEffect, pendingRestoreNotice, restorePendingStash, submitOperationStep } from './operation-actions.ts'
import { createPendingStashStore, usePendingStashState } from '../store/pending-stash-store.ts'
import type { OperationStepKind } from './operation-actions.ts'
import type { RollbackTarget } from '../store/push-store.ts'
import type { DiffOpenScope } from './ChangesTree.tsx'
import { CommitPanel } from './CommitPanel.tsx'
import { PageTabs } from './PageTabs.tsx'
import type { WorkbenchPage } from './PageTabs.tsx'
import { PushPage } from './PushPage.tsx'
import { StashCreateSheet } from './StashCreateSheet.tsx'
import { StashPage } from './StashPage.tsx'
import { RollbackSheet } from './RollbackSheet.tsx'
import { text, useT } from '../i18n.tsx'
import type { LocalizedText } from '../i18n.tsx'
import { readOnlyMessage } from '../localized-text.ts'
import { ReadOnlyBanner } from '../read-only-banner.tsx'
import { createDetailStore, useDetailState } from '../store/detail-store.ts'
import { createDiffStore } from '../store/diff-store.ts'
import { intentEffect, subscribeIntents } from '../workbench-intents.ts'
import type { WorkbenchIntent } from '../workbench-intents.ts'
import { createFileHistoryStore } from '../store/file-history-store.ts'
import { createLogStore } from '../store/log-store.ts'
import { ActionNotice } from './ActionNotice.tsx'
import { BranchPanel } from './BranchPanel.tsx'
import { BranchSheet } from './BranchSheets.tsx'
import { BranchesPage } from './BranchesPage.tsx'
import { SmartCheckoutSheet } from './SmartCheckoutSheet.tsx'
import { CommitOpSheet } from './CommitOpSheet.tsx'
import { FetchSheet } from './FetchSheet.tsx'
import { MergePage } from './MergePage.tsx'
import { PullPage } from './PullPage.tsx'
import { ResetSheet } from './ResetSheet.tsx'
import { UpdateProjectPage } from './UpdateProjectPage.tsx'
import { commitActionEffect } from './commit-actions.ts'
import type { CommitActionId } from './commit-actions.ts'
import { FETCH_ALL, branchActionContext, createBranchActionRunner, outcomeNotice, pathsLimitNotice, writeBlock } from './branch-actions.ts'
import type { ActionNotice as ActionNoticeValue, BranchActionRunnerDeps, QuickActionId } from './branch-actions.ts'
import { createBranchesStore, useBranchesState } from './branch-store.ts'
import { CommitDetail } from './CommitDetail.tsx'
import { ActionMenu } from './ActionMenu.tsx'
import { BlameOverlay } from './BlameView.tsx'
import { ComparePage } from './ComparePage.tsx'
import { InteractiveRebasePage, afterInteractiveRebase } from './InteractiveRebasePage.tsx'
import { ApplyPatchPage, CreateTagSheet, FixupIntoSheet, PatchPage } from './CommitMenuSheets.tsx'
import { ShelfPanel, ShelveSheet, shelvePaths, useShelfStore } from './ShelfPanel.tsx'
import { ChangelistPanel } from './ChangelistView.tsx'
import { RemoteBranchDeleteSheet, TagSheet, UpstreamSheet, WorktreeAddSheet } from './RemoteSheets.tsx'
import { RemotesPage, WorktreesPage } from './RemotesPages.tsx'
import { addList, moveTo, removeList, renameList, setActive } from '../changelists/changelist-model.ts'
import { useChangelists } from '../changelists/use-changelists.ts'
import { readChangelistGrouping, writeChangelistGrouping } from '../settings.ts'
import { DiffViewer } from './DiffViewer.tsx'
import { FileHistoryPage } from './FileHistoryPage.tsx'
import { fileActions } from './file-actions.ts'
import type { FileActionId } from './file-actions.ts'
import type { MenuAnchor } from './menu-position.ts'
import { DirtyWorktreeSheet } from './DirtyWorktreeSheet.tsx'
import css from './GitWorkbench.module.css'
import { LogPage } from './LogPage.tsx'
import type { LogSelection } from './LogPage.tsx'
import { OperationBanner, PendingStashBar, bannerFromStatus } from './OperationBanner.tsx'
import { RepoBar } from './RepoBar.tsx'
import { StatusBar } from './StatusBar.tsx'
import {
  actionOverlayWiring,
  asBack,
  keepsFileHistory,
  dirtySheetHandlers,
  handleOverlayEscape,
  overlayLeaveEffects,
  pushConflictWiring,
  useWorkbenchOverlay,
} from './workbench-overlay.ts'
import type { FocusTarget, WorkbenchOverlay } from './workbench-overlay.ts'

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
  /** B1: the panel's fullscreen state and toggle (the merge window enters host fullscreen). */
  sidebar?: SidebarFullscreen | undefined
}

/** Push 覆盖页的打开方式：普通打开，或打开后立即推送（提交并推送）。 */
type OpenPush = Omit<Extract<WorkbenchOverlay, { kind: 'push' }>, 'kind'>

/**
 * 「提交并推送」能否直接推（评审 I3）：只在 upstream 是同名远程分支时。
 * `git switch -c fix origin/main` 让 fix 的 upstream 指向 main，此时要打开 Push 页让用户选目标，
 * 与 git 默认的 `push.default=simple` 一致。
 */
export function directPushAllowed(status: StatusValue | null): boolean {
  if (status === null || status.detached || status.branch === null || status.upstream === null) return false
  const suffix = `/${status.branch}`
  if (!status.upstream.endsWith(suffix)) return false
  const remote = status.upstream.slice(0, -suffix.length)
  return remote !== '' && !remote.includes('/')
}

/** 提交页打开工作区/暂存区 diff 时，Diff 覆盖层可切换的同组文件。 */
export function changeFilesFor(status: StatusValue | null, scope: DiffOpenScope): FileEntry[] {
  if (status === null) return []
  return scope === 'staged' ? status.staged : [...status.conflicts, ...status.unstaged, ...status.untracked]
}

/** 「已提交 <sha>」提示是否过期：HEAD 已移走（如推送被拒后拉取变基）时不再显示旧哈希。 */
export function commitFeedbackIsStale(committedSha: string | null, head: string | null): boolean {
  return committedSha !== null && head !== null && committedSha !== head
}

/**
 * 提交是否刚变为失败（验收演示问题 2）：失败时也要刷新一次 bootstrap，否则提交进行中那次轮询
 * 带回的 `pendingWrites=1` 会让「等待当前操作完成」多停留一个轮询周期。
 */
export function commitFailedJustNow(previous: CommitPhase, next: CommitPhase): boolean {
  return next === 'failure' && previous !== 'failure'
}

/** 开始其它写操作时是否清掉提交页的提示（验收演示问题 3）：旧的失败提示不该跟着后续操作一直挂着。 */
export function commitNoticeClearsOnOtherWrite(phase: CommitPhase): boolean {
  return phase === 'failure'
}

/** 回滚目标：未跟踪文件只能删除，需要危险确认。 */
export function rollbackTargetsFor(status: StatusValue | null, paths: readonly string[]): RollbackTarget[] {
  const untracked = new Set(status?.untracked.map(entry => entry.path) ?? [])
  return paths.map(path => ({ path, untracked: untracked.has(path) }))
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
  const t = useT()
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
  const stashStore = useMemo(() => createStashStore({
    loadList: () => client.stashList(sessionId),
    loadFiles: (sha, signal) => client.stashFiles({ sessionId, sha }, signal),
  }), [client, sessionId])
  const consoleStore = useMemo(
    () => createConsoleStore({ load: signal => client.console(sessionId, signal) }),
    [client, sessionId],
  )
  useEffect(() => () => { logStore.dispose() }, [logStore])
  useEffect(() => () => { detailStore.cancel() }, [detailStore])
  useEffect(() => () => { consoleStore.reset() }, [consoleStore])

  const repoRoot = value.repoRoot ?? ''
  // B3c review I6: a new repository gets a fresh store, so changelists never sync the old paths.
  const changesStore = useMemo(() => createChangesStore(), [sessionId, value.repoRoot])
  const commitStore = useMemo(
    () => createCommitStore({ sessionId, repoRoot, client }),
    [client, repoRoot, sessionId],
  )
  useEffect(() => { changesStore.setStatus(status) }, [changesStore, status])
  const changes = useChangesState(changesStore)
  const changelists = useChangelists(value.repoRoot, changes.loaded ? changes.entries.map(entry => entry.path) : null)
  const commit = useCommitState(commitStore)
  const statusSawCommit = useRef(false)
  const previousPhase = useRef<CommitPhase>(commit.phase)
  useEffect(() => {
    if (commitFailedJustNow(previousPhase.current, commit.phase)) void onRefresh()
    previousPhase.current = commit.phase
  }, [commit.phase, onRefresh])
  const clearStaleCommitNotice = useCallback(() => {
    if (commitNoticeClearsOnOtherWrite(commitStore.getState().phase)) commitStore.dismiss()
  }, [commitStore])
  const committedSha = commit.phase === 'success' ? (commit.lastCommit?.sha ?? null) : null
  const statusHead = status?.head ?? null
  useEffect(() => {
    // Wait for the status to reach the new commit first; only a later move of HEAD makes it stale.
    if (commitFeedbackIsStale(committedSha, statusHead) && statusSawCommit.current) commitStore.dismiss()
    if (committedSha !== null && committedSha === statusHead) statusSawCommit.current = true
    if (committedSha === null) statusSawCommit.current = false
  }, [commitStore, committedSha, statusHead])
  const [page, setPage] = useState<WorkbenchPage>('log')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [branchesSearch, setBranchesSearch] = useState('')
  const [notice, setNotice] = useState<ActionNoticeValue | null>(null)

  // 写动作框架（A3 T6）：回调经 ref 取最新值，store 只随会话重建。
  const actionCallbacks = useRef<{
    onRefresh: () => Promise<unknown>
    openOverlay: (overlay: WorkbenchOverlay, trigger: FocusTarget | null) => void
  }>({ onRefresh, openOverlay: () => undefined })
  actionCallbacks.current.onRefresh = onRefresh
  const actions = useMemo(() => createActionStore({
    client,
    sessionId,
    ...actionOverlayWiring({
      open: (next, trigger) => { actionCallbacks.current.openOverlay(next, trigger) },
      refresh: () => { void actionCallbacks.current.onRefresh() },
    }),
  }), [client, sessionId])
  const actionState = useActionState(actions)
  // 覆盖层同一时刻只有一个（设计 §5.3）：打开新的替换旧的；离开智能操作询问即视为取消。
  // B1 T7: a dirty merge window is asked before another entry point replaces it (mergeLeaveGuard is
  // filled by the open window); leaving it updates the conflict list / Review queue (mergeLeft).
  // B2 file history: kept above the overlay so "← back" from Blame finds selection and scroll as they were.
  const historyDiffStore = useMemo(() => createDiffStore({ load: (request, signal) => client.diff(request, signal) }), [client])
  const historyStore = useMemo(
    () => createFileHistoryStore({ sessionId, load: (request, signal) => client.fileHistory(request, signal), diff: historyDiffStore }),
    [client, historyDiffStore, sessionId],
  )
  const historyScroll = useRef(0)
  const mergeLeaveGuard = useRef<((go: () => void, cancel?: () => void) => boolean) | null>(null)
  const mergeLeft = useRef<(path: string, next: WorkbenchOverlay | null) => void>(() => {})
  const leaveEffects = overlayLeaveEffects(actions)
  const overlays = useWorkbenchOverlay(
    (left, next) => {
      leaveEffects(left, next)
      if (left.kind === 'mergeWindow') mergeLeft.current(left.path, next)
      // B2: the history page keeps its store across Blame/compare and back; release it after.
      if (!keepsFileHistory(next)) historyStore.close()
    },
    // A pending action's dirty-worktree ask held by the window's question: not leaving cancels it.
    (current, next, proceed) => current.kind === 'mergeWindow'
      && mergeLeaveGuard.current?.(proceed, next?.kind === 'dirtyWorktree' ? () => { actions.cancelStash() } : undefined) === true,
  )
  actionCallbacks.current.openOverlay = overlays.open
  const dirtyHandlers = dirtySheetHandlers(actions, overlays)
  const overlay = overlays.overlay
  const diff = overlay?.kind === 'diff' ? overlay : null
  const push = overlay?.kind === 'push' ? overlay : null
  const rollback = overlay?.kind === 'rollback' ? overlay.targets : null

  const detail = useDetailState(detailStore)
  const branches = useBranchesState(branchesStore)
  const consoleState = useConsoleState(consoleStore)

  const [refsBySha, setRefsBySha] = useState<Record<string, RefEntry[]> | undefined>(undefined)
  const [selectedFile, setSelectedFile] = useState<{ path: string; parentSha?: string } | undefined>(undefined)
  // B2: right-click menu of a commit detail file row.
  const [fileMenu, setFileMenu] = useState<{ file: CommitFileEntry; parentSha: string | undefined; anchor: MenuAnchor } | null>(null)
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

  // Stash page (A3 T10): load on entering the page and whenever the repository version moves.
  useEffect(() => {
    if (page === 'stash') void stashStore.refresh()
  }, [page, stashStore, value.version])

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
    overlays.open({
      kind: 'diff',
      request: {
        sessionId,
        scope: 'commit',
        sha: commit.sha,
        path: file.path,
        ...(parent === undefined ? {} : { parent }),
      },
      files: diffFilesOf(commit),
      source: [text('diff.source.log'), commit.shortSha],
    })
  }, [overlays.open, sessionId])

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

  // B2: intents from the document header and the git.blame page (queued while this tab was not mounted).
  const intentHandler = useRef<(intent: WorkbenchIntent) => void>(() => undefined)
  intentHandler.current = (intent) => {
    const effect = intentEffect(intent, status)
    if (effect.kind === 'overlay') overlays.open(effect.overlay, null)
    else if (effect.kind === 'diff') openWorktreeDiff(effect.path, effect.scope)
    else if (effect.kind === 'showCommit') showCommitInLog(effect.sha)
    else {
      overlays.dismiss()
      setPage('commit')
      changesStore.setFocused(effect.path)
    }
  }
  useEffect(() => subscribeIntents(sessionId, (intent) => { intentHandler.current(intent) }), [sessionId])

  /** B2: leave the overlay chain and reveal one commit in the log. */
  const showCommitInLog = useCallback((sha: string) => {
    overlays.dismiss()
    setPage('log')
    navigateTo(sha)
  }, [navigateTo, overlays.dismiss])

  const openPush = useCallback((open: OpenPush) => {
    clearStaleCommitNotice()
    overlays.open({ kind: 'push', ...open })
  }, [clearStaleCommitNotice, overlays.open])

  const openWorktreeDiff = useCallback((path: string, scope: DiffOpenScope) => {
    overlays.open({
      kind: 'diff',
      request: { sessionId, scope, path },
      files: changeFilesFor(status, scope),
      source: [text('diff.source.commit'), text(scope === 'staged' ? 'diff.source.staged' : 'diff.source.worktree')],
    })
  }, [overlays.open, sessionId, status])

  const onCommitted = useCallback((result: CommitResultValue) => {
    // 刷新状态与日志后在日志里定位新 HEAD（切回日志页时可见）。
    void Promise.all([onRefresh(), logStore.refresh()]).then(() => { logStore.jumpTo(result.sha) })
  }, [logStore, onRefresh])

  /** 提交并推送：在 Push 页里执行（进度、认证命令、错误、被拒都在那里呈现）；非同名 upstream 时只打开不自动推。 */
  const pushAfterCommit = useCallback((openPushPage: boolean): void => {
    openPush(!openPushPage && directPushAllowed(status) ? { autoSubmit: true } : {})
  }, [openPush, status])

  const addToVcs = useCallback(async (paths: string[]): Promise<void> => {
    clearStaleCommitNotice()
    const limit = pathsLimitNotice(paths.length)
    if (limit !== null) {
      setNotice(limit)
      return
    }
    const result = await client.addToVcs({ sessionId, requestId: newRequestId(), paths })
    // 失败原因在 Git 控制台里（每条命令都有记录）。
    if (!result.ok) setConsoleOpen(true)
    void onRefresh()
  }, [clearStaleCommitNotice, client, onRefresh, sessionId])

  // Operation state, conflict list and operation-state commit (A3 T9).
  const conflictStore = useMemo(
    () => createConflictStore({
      load: signal => client.operationState(sessionId, signal),
      loadFile: (path, signal) => client.mergeFile({ sessionId, path }, signal),
    }),
    [client, sessionId],
  )
  const conflictState = useConflictState(conflictStore)
  const autoOpen = useMemo(() => createAutoOpenTracker(), [sessionId])
  const operation = status?.operation ?? null
  const statusKnown = status !== null
  const closeOverlayIf = overlays.closeIf
  const unmerged = status?.conflicts.length ?? 0
  const listActive = useRef(false)
  useEffect(() => {
    if (!statusKnown) return
    if (operation === null) autoOpen.observe(null)
    // Carry 4: unmerged entries without an operation (the stash pop after an integrate conflicted)
    // keep the list loaded; it closes once nothing is left (finished or aborted elsewhere too).
    const sync = conflictListSync(listActive.current, operation, unmerged)
    listActive.current = sync.active
    if (sync.close) {
      closeOverlayIf('conflicts')
      closeOverlayIf('mergeWindow')
    }
    if (sync.load === 'clear') conflictStore.clear()
    else void conflictStore.refresh()
  }, [autoOpen, closeOverlayIf, conflictStore, operation, statusKnown, unmerged, value.version])
  const operationValue = conflictState.value
  const openOverlay = overlays.open
  const currentRoute = overlays.route
  useEffect(() => {
    if (operationValue === null) return
    // Once per operation (design §10.1); never over another overlay the user is working in.
    if (autoOpen.observe(operationValue) && currentRoute().overlay === null) openOverlay({ kind: 'conflicts' }, null)
  }, [autoOpen, currentRoute, openOverlay, operationValue])
  const conflictsOpen = overlay?.kind === 'conflicts'
  useEffect(() => { if (conflictsOpen) autoOpen.noteOpened() }, [autoOpen, conflictsOpen])
  const pageMode = commitPageModeOf(operation, status?.rebaseStop)
  const operationKey = operationValue === null ? null : operationIdentity(operationValue)
  const mergeMsg = mergePrefill(operationValue)
  useEffect(() => {
    commitStore.setOperation({ mode: pageMode, message: mergeMsg, key: operationKey })
  }, [commitStore, mergeMsg, operationKey, pageMode])

  /** Banner / list / commit-page results: notices, reload the list, show the new HEAD in the log. */
  const applyOperationOutcome = useCallback((outcome: ActionOutcome<unknown>, step: OperationStepKind) => {
    const effect = operationOutcomeEffect(outcome, step)
    setNotice(effect.notice)
    if (effect.refreshConflicts) void conflictStore.refresh()
    if (effect.finished) overlays.closeIf('conflicts')
    const sha = effect.showInLog
    if (sha !== null) {
      setPage('log')
      void Promise.all([onRefresh(), logStore.refresh()]).then(() => { logStore.jumpTo(sha) })
    }
  }, [conflictStore, logStore, onRefresh, overlays.closeIf])
  const runOperationControl = useCallback((action: OperationControlAction, trigger: FocusTarget | null) => {
    setNotice(null)
    void controlOperation({ actions, trigger }, action).then((outcome) => { applyOperationOutcome(outcome, action) })
  }, [actions, applyOperationOutcome])
  const openConflicts = useCallback((trigger: FocusTarget | null) => {
    void conflictStore.refresh()
    overlays.open({ kind: 'conflicts' }, trigger)
  }, [conflictStore, overlays.open])
  const submitOperation = useCallback((trigger: FocusTarget | null) => {
    const state = commitStore.getState()
    if (state.mode === 'normal') return
    const mode = state.mode
    setNotice(null)
    void commitStore.runOperation(() => submitOperationStep({ actions, trigger }, mode, visibleMessage(state))).then((outcome) => {
      // The commit page shows its own failure.
      if (outcome.kind !== 'failed') applyOperationOutcome(outcome, mode === 'merge' ? 'commit' : 'continue')
    })
  }, [actions, applyOperationOutcome, commitStore])

  // Final review 2b: a pending stash whose operation ended outside the UI (terminal / Agent).
  const pendingStashStore = useMemo(
    () => createPendingStashStore({ load: () => client.operationState(sessionId) }),
    [client, sessionId],
  )
  const pendingStash = usePendingStashState(pendingStashStore)
  const stashCount = status?.stashCount ?? 0
  useEffect(() => {
    if (!statusKnown) return
    void pendingStashStore.sync({ operation, version: value.version, stashCount })
  }, [operation, pendingStashStore, stashCount, statusKnown, value.version])
  const restorePending = useCallback((trigger: FocusTarget | null) => {
    setNotice(null)
    void restorePendingStash({ actions, trigger }).then((outcome) => {
      setNotice(pendingRestoreNotice(outcome))
      void onRefresh()
      void pendingStashStore.recheck()
    })
  }, [actions, onRefresh, pendingStashStore])

  // Branch actions (A3 T7): the runner is created once per action store and reads the latest
  // callbacks through a ref, so menus and sheets never act on a stale log store or page setter.
  // B3d: tag / remote-branch / upstream items, and worktrees behind their flag.
  const worktreesEnabled = useMemo(() => isFeatureEnabled('worktrees'), [])
  const branchContext = { ...branchActionContext(status, value.writePolicy), remotes: { worktrees: worktreesEnabled } }
  const runnerDeps = useRef<BranchActionRunnerDeps | null>(null)
  runnerDeps.current = {
    actions,
    openOverlay: overlays.open,
    copy: text => { void globalThis.navigator?.clipboard?.writeText(text) },
    showInLog: (entry) => {
      setPage('log')
      navigateTo(entry.ref === 'HEAD' ? entry.sha : entry.ref)
    },
    filterLog: (entry) => {
      setPage('log')
      logStore.setFilter({ branches: [entry.name] })
    },
    openPush: () => { openPush({}) },
    onOutcome: (outcome) => { setNotice(outcomeNotice(outcome)) },
    currentBranch: () => (status === null || status.detached ? null : status.branch),
  }
  const branchRunner = useMemo(() => createBranchActionRunner({
    actions,
    openOverlay: (overlay, trigger) => { runnerDeps.current?.openOverlay(overlay, trigger) },
    copy: (text) => { runnerDeps.current?.copy(text) },
    showInLog: (entry) => { runnerDeps.current?.showInLog(entry) },
    filterLog: (entry) => { runnerDeps.current?.filterLog(entry) },
    openPush: () => { runnerDeps.current?.openPush() },
    onOutcome: (outcome) => { runnerDeps.current?.onOutcome(outcome) },
    currentBranch: () => runnerDeps.current?.currentBranch?.() ?? null,
  }), [actions])
  const reportOutcome = useCallback((outcome: ActionOutcome<unknown>) => { setNotice(outcomeNotice(outcome)) }, [])
  const runQuickAction = useCallback((id: QuickActionId, trigger: FocusTarget | null) => {
    setNotice(null)
    switch (id) {
      case 'update':
        overlays.open({ kind: 'updateProject' }, trigger)
        return
      case 'commit':
        setPage('commit')
        return
      case 'push':
        openPush({})
        return
      case 'continue':
      case 'abort':
        runOperationControl(id, trigger)
        return
      case 'newBranch':
        overlays.open({ kind: 'branchSheet', mode: 'new', startPoint: status?.branch ?? 'HEAD' }, trigger)
        return
      case 'checkoutRevision':
        overlays.open({ kind: 'branchSheet', mode: 'checkoutRevision' }, trigger)
        return
    }
  }, [openPush, overlays.open, runOperationControl, status?.branch])

  const readOnlyReason = readOnlyMessage(t, value.writePolicy, 'readOnly.title')

  // B1 three-pane merge window (feature flag `mergeWindow`; off = A3 conflict list unchanged).
  const mergeEnabled = useMemo(() => isFeatureEnabled('mergeWindow'), [])
  const rebaseEnabled = useMemo(() => isFeatureEnabled('interactiveRebase'), [])
  // B3c: the Stash page has a Stash / Shelf segment; the shelf store lives with the workbench.
  const [stashSegment, setStashSegment] = useState<'stash' | 'shelf'>('stash')
  const shelfStore = useShelfStore(client, sessionId)
  const [changelistGrouped, setChangelistGrouped] = useState(() => readChangelistGrouping())
  const mergeBlock = useRef<LocalizedText | null>(null)
  const overlayOpen = overlays.open
  const review = useMemo(() => createMergeReviewWiring({
    conflicts: conflictStore,
    open: overlayOpen,
    refreshStatus: () => { void actionCallbacks.current.onRefresh() },
  }), [conflictStore, overlayOpen])
  const mergeStore = useMemo(() => createMergeStore({
    loadFile: (path, signal) => client.mergeFile({ sessionId, path }, signal),
    actions,
    readOnlyReason: () => mergeBlock.current,
    // Opening a file in the window counts as reviewing it (confirmation 2; whole-file takes happen there too).
    onOpened: review.opened,
    onLoadFailed: review.loadFailed,
    onApplied: review.applied,
  }), [actions, client, review, sessionId])
  mergeLeft.current = review.left
  const openMergeWindow = useCallback((path: string, trigger: FocusTarget | null) => {
    setNotice(null)
    overlays.open({ kind: 'mergeWindow', path }, trigger)
  }, [overlays.open])
  const startReview = useCallback((queue: string[], trigger: FocusTarget | null) => {
    setNotice(null)
    review.start(queue, trigger)
  }, [review])

  // Integrate pages (A3 T8): writes are blocked while read-only or an operation is in progress;
  // fetch only needs a writable repository.
  const integrateBlock = writeBlock(branchContext)
  const fetchBlock = writeBlock({ writable: branchContext.writable, operation: null })
  mergeBlock.current = fetchBlock ?? null
  const stashBusy = Object.keys(actionState.pending).some(key => key.startsWith('stash'))
  const blockText = (reason: typeof integrateBlock): string | null => (reason === undefined ? null : t(reason.key, reason.params))
  const runCommitAction = useCallback((id: CommitActionId, commit: CommitSummary, trigger: FocusTarget | null, childSha: string | null) => {
    const log = logStore.getState()
    const selected = log.commits.filter(candidate => log.selection.includes(candidate.sha))
    const effect = commitActionEffect(id, commit, childSha, selected)
    if (effect === null) return
    if (effect.kind === 'copy') void globalThis.navigator?.clipboard?.writeText(effect.value)
    else if (effect.kind === 'jump') navigateTo(effect.sha)
    else {
      setNotice(null)
      overlays.open(effect.overlay, trigger)
    }
  }, [logStore, navigateTo, overlays.open])

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
        onFileMenu={(file, parentSha, anchor) => { setFileMenu({ file, parentSha, anchor }) }}
        onNavigate={navigateTo}
        onRetry={() => { void detailStore.reload() }}
      />
    )
  ), [detail, detailStore, navigateTo, openFile, selectedFile])

  /** B2: what a commit detail file menu item does. */
  const runFileAction = (id: FileActionId, commit: CommitDetailValue, file: CommitFileEntry, parentSha: string | undefined): void => {
    if (id === 'showDiff') openFile(commit, file, parentSha)
    else if (id === 'fileHistory') overlays.open({ kind: 'fileHistory', path: file.path, rev: commit.sha })
    else if (id === 'blameRevision') overlays.open({ kind: 'blame', path: file.path, rev: commit.sha })
    else if (id === 'compareWorktree') {
      overlays.open({
        kind: 'diff',
        request: { sessionId, scope: 'range', from: commit.sha, to: null, path: file.path },
        files: [file],
        source: [text('diff.source.log'), commit.shortSha, text('compare.worktree')],
      })
    } else void globalThis.navigator?.clipboard?.writeText(file.path)
  }

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
      actionContext={branchContext}
      onAction={(id, entry, trigger) => {
        setNotice(null)
        void branchRunner.run(id, entry, trigger)
      }}
    />
  )
  const wide = branches.mode === 'wide'

  return (
    <div ref={rootRef} className={css.root} data-dsh-git-workbench="" data-mode={branches.mode}>
      <ReadOnlyBanner policy={value.writePolicy} />
      <OperationBanner
        {...bannerFromStatus(status)}
        pendingStash={operationValue?.pendingStash === true}
        busy={operationBusy(actionState.pending)}
        blockReason={blockText(fetchBlock)}
        onResolve={openConflicts}
        onContinue={(trigger) => { runOperationControl('continue', trigger) }}
        onSkip={(trigger) => { runOperationControl('skip', trigger) }}
        onAbort={(trigger) => { runOperationControl('abort', trigger) }}
        onOpenConsole={() => { setConsoleOpen(true) }}
      />
      {operation === null && pendingStash.pending
        ? (
            <PendingStashBar
              busy={operationBusy(actionState.pending)}
              blockReason={blockText(fetchBlock)}
              onRestore={restorePending}
              onGoStash={() => {
                setNotice(null)
                setPage('stash')
              }}
            />
          )
        : null}
      <RepoBar
        repoRoot={value.repoRoot}
        refreshing={refreshing}
        mode={branches.mode}
        branchesOpen={branches.open}
        consoleHasErrors={consoleState.failedCount > 0}
        onRefresh={() => { void refreshAll() }}
        onOpenConsole={() => { setConsoleOpen(true) }}
        onApplyPatch={(trigger) => { overlays.open({ kind: 'applyPatch' }, trigger) }}
        onRemotes={(trigger) => { overlays.open({ kind: 'remotes' }, trigger) }}
        {...(worktreesEnabled ? { onWorktrees: (trigger: HTMLElement | null) => { overlays.open({ kind: 'worktrees' }, trigger) } } : {})}
        onToggleBranches={() => { branchesStore.setOpen(!branches.open) }}
        onPush={() => { openPush({}) }}
        ahead={status?.ahead ?? 0}
        onFetch={() => {
          setNotice(null)
          overlays.open({ kind: 'fetch' })
        }}
        fetchDisabledReason={blockText(fetchBlock)}
        onPull={() => {
          setNotice(null)
          overlays.open({ kind: 'pull' })
        }}
        pullDisabledReason={blockText(integrateBlock)}
      />
      <PageTabs page={page} onChange={setPage} uncommittedCount={uncommittedCount(status)} stashCount={status?.stashCount ?? 0} />
      <ActionNotice
        notice={notice}
        onDismiss={() => { setNotice(null) }}
        onAction={(action) => {
          // "Go to the stash page": the kept stash is restored from there.
          if (action === 'goStash') {
            setNotice(null)
            setPage('stash')
          }
        }}
      />
      <div className={css.content} onKeyDown={event => { handleOverlayEscape(event, overlays.route(), overlays.close) }}>
        {page === 'log' ? (
          <LogPage
            store={logStore}
            {...(refsBySha === undefined ? {} : { refsBySha })}
            headSha={status?.head ?? null}
            currentBranch={status?.branch ?? null}
            onSelect={onSelect}
            onOpenCommit={onOpenCommit}
            renderDetail={renderDetail}
            commitMenu={{ writable: branchContext.writable, operation: branchContext.operation, onAction: runCommitAction, rebase: rebaseEnabled, checkedCount: changes.checked.size, ...(status?.head === undefined || status.head === null ? {} : { headSha: status.head }) }}
            {...(wide ? { sidebar: branchPanel } : {})}
          />
        ) : page === 'branches' ? (
          <BranchesPage
            value={branches.value}
            loading={branches.loading}
            error={branches.error}
            context={branchContext}
            search={branchesSearch}
            collapsedGroups={branches.collapsedGroups}
            collapsedDirs={branches.collapsedDirs}
            flat={branches.flat}
            fetching={actions.isRunning('fetch', FETCH_ALL)}
            onSearchChange={setBranchesSearch}
            onToggleGroup={kind => { branchesStore.toggleGroup(kind) }}
            onToggleDirectory={path => { branchesStore.toggleDirectory(path) }}
            onAction={(id, entry, trigger) => {
              setNotice(null)
              void branchRunner.run(id, entry, trigger)
            }}
            onQuickAction={runQuickAction}
            onFetch={(trigger) => {
              setNotice(null)
              overlays.open({ kind: 'fetch' }, trigger)
            }}
            onRetry={() => { void loadSideData() }}
            onOpenConsole={() => { setConsoleOpen(true) }}
          />
        ) : page === 'stash' ? (
          <div className={css.stashSegments}>
            <div className={css.segmentBar} role="tablist" aria-label={t('shelf.segment.label')}>
              <button type="button" role="tab" aria-selected={stashSegment === 'stash'} onClick={() => { setStashSegment('stash') }}>{t('shelf.segment.stash')}</button>
              <button type="button" role="tab" aria-selected={stashSegment === 'shelf'} data-shelf-tab onClick={() => { setStashSegment('shelf') }}>{t('shelf.segment.shelf')}</button>
            </div>
            {stashSegment === 'shelf' ? (
              <ShelfPanel
                store={shelfStore}
                actions={actions}
                busy={stashBusy}
                blockReason={blockText(integrateBlock)}
                version={value.version}
                onConflicts={(trigger) => { overlays.open({ kind: 'conflicts' }, trigger) }}
                onApplied={() => { void onRefresh() }}
              />
            ) : (
              <StashPage
                store={stashStore}
                sessionId={sessionId}
                actions={actions}
                busy={stashBusy}
                block={integrateBlock}
                dropBlock={fetchBlock}
                onNotice={setNotice}
                onOpenDiff={(request, files, source) => {
                  overlays.open({ kind: 'diff', request, files, source })
                }}
                onCreate={(trigger) => {
                  setNotice(null)
                  overlays.open({ kind: 'stashCreate' }, trigger)
                }}
                onRetry={() => { void stashStore.refresh() }}
              />
            )}
          </div>
        ) : (
          <CommitPanel
            changesStore={changesStore}
            changes={changes}
            commitStore={commitStore}
            commit={commit}
            status={status}
            writePolicy={value.writePolicy}
            {...(value.pendingWrites === undefined ? {} : { pendingWrites: value.pendingWrites })}
            onOpenDiff={openWorktreeDiff}
            changelists={{
              grouped: changelistGrouped,
              onGrouped: (on) => { setChangelistGrouped(on); writeChangelistGrouping(on) },
              panel: (
                <ChangelistPanel
                  entries={changes.entries}
                  checked={changes.checked}
                  state={changelists.state}
                  writeDisabled={!branchContext.writable}
                  onToggleFile={(path) => { changesStore.toggleFile(path) }}
                  onSetChecked={(paths, checked) => { changesStore.setChecked(paths, checked) }}
                  onOpenDiff={(entry) => { openWorktreeDiff(entry.path, entry.diffScope) }}
                  onMove={(paths, id) => { changelists.update(current => moveTo(current, paths, id)) }}
                  onSetActive={(id) => { changelists.update(current => setActive(current, id)) }}
                  onAdd={(name) => { changelists.update(current => addList(current, name).state) }}
                  onRename={(id, name) => { changelists.update(current => renameList(current, id, name)) }}
                  onRemove={(id) => { changelists.update(current => removeList(current, id)) }}
                />
              ),
            }}
            onShelve={(path, trigger) => { overlays.open({ kind: 'shelve', paths: shelvePaths(path, changes.checked) }, trigger) }}
            onRollback={paths => {
              clearStaleCommitNotice()
              overlays.open({ kind: 'rollback', targets: rollbackTargetsFor(status, paths) })
            }}
            onAddToVcs={paths => { void addToVcs(paths) }}
            onCopyPath={path => { void globalThis.navigator?.clipboard?.writeText(path) }}
            onFileHistory={path => { overlays.open({ kind: 'fileHistory', path }) }}
            onBlame={path => { overlays.open({ kind: 'blame', path }) }}
            onCommitted={onCommitted}
            onPushAfterCommit={(_result, options) => { pushAfterCommit(options.openPushPage) }}
            onShowConsole={() => { setConsoleOpen(true) }}
            onRefresh={() => { void onRefresh() }}
            onOperationSubmit={submitOperation}
            onResolveConflicts={openConflicts}
          />
        )}
        {page === 'log' && !wide ? branchPanel : null}
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
            onClose={() => { overlays.closeIf('diff') }}
          />
        )}
        {fileMenu === null || detail.value === null ? null : (
          <ActionMenu
            label={t('file.menu', { path: fileMenu.file.path })}
            items={fileActions({ kind: 'commitFile', status: fileMenu.file.status })}
            anchor={fileMenu.anchor}
            onClose={() => { setFileMenu(null) }}
            onSelect={(id) => {
              const { file, parentSha } = fileMenu
              setFileMenu(null)
              if (detail.value !== null) runFileAction(id, detail.value, file, parentSha)
            }}
          />
        )}
        {overlay?.kind === 'blame' ? (
          <BlameOverlay
            sessionId={sessionId}
            target={overlay.rev === undefined ? { path: overlay.path } : { path: overlay.path, rev: overlay.rev }}
            load={(request, signal) => client.blame(request, signal)}
            loadDiff={(request, signal) => client.diff(request, signal)}
            branch={status?.branch ?? null}
            onBack={() => { overlays.close() }}
            onShowInLog={showCommitInLog}
            onFileHistory={(path) => { overlays.open({ kind: 'fileHistory', path, back: asBack(overlay) }) }}
          />
        ) : null}
        {overlay?.kind === 'fileHistory' ? (
          <FileHistoryPage
            store={historyStore}
            diff={historyDiffStore}
            target={overlay.rev === undefined ? { path: overlay.path } : { path: overlay.path, rev: overlay.rev }}
            scroll={historyScroll}
            onBack={() => { overlays.close() }}
            onAction={(id, entry) => {
              const back = asBack(overlay)
              if (id === 'blameRevision') overlays.open({ kind: 'blame', path: entry.path, rev: entry.sha, back })
              else if (id === 'compareWorktree') overlays.open({ kind: 'compare', left: entry.sha, right: null, leftLabel: entry.shortSha, rightLabel: null, back })
              else if (id === 'showInLog') showCommitInLog(entry.sha)
              else void globalThis.navigator?.clipboard?.writeText(entry.path)
            }}
          />
        ) : null}
        {overlay?.kind === 'compare' ? (
          <ComparePage
            sessionId={sessionId}
            left={overlay.left}
            right={overlay.right}
            leftLabel={overlay.leftLabel}
            rightLabel={overlay.rightLabel}
            load={(request, signal) => client.compare(request, signal)}
            loadDiff={(request, signal) => client.diff(request, signal)}
            onBack={() => { overlays.close() }}
            onShowInLog={showCommitInLog}
          />
        ) : null}
        {overlay?.kind === 'undoCommit' ? (
          <ResetSheet
            key={`undo:${overlay.sha}`}
            sha={overlay.parent}
            initialMode="soft"
            loadPreview={request => client.resetPreview({ sessionId, ...request })}
            actions={actions}
            onOutcome={reportOutcome}
            onClose={() => { overlays.closeIf('undoCommit') }}
          />
        ) : null}
        {overlay?.kind === 'createTag' ? (
          <CreateTagSheet
            key={overlay.sha}
            sha={overlay.sha}
            shortSha={overlay.shortSha}
            actions={actions}
            onOutcome={reportOutcome}
            onClose={() => { overlays.closeIf('createTag') }}
          />
        ) : null}
        {overlay?.kind === 'fixupInto' ? (
          <FixupIntoSheet
            key={`${overlay.mode}:${overlay.sha}`}
            sha={overlay.sha}
            shortSha={overlay.shortSha}
            subject={overlay.subject}
            mode={overlay.mode}
            paths={[...changes.checked]}
            actions={actions}
            onDone={(result, trigger) => {
              afterInteractiveRebase(result, {
                openConflicts: () => { overlays.open({ kind: 'conflicts' }, trigger) },
                close: () => { overlays.closeIf('fixupInto') },
                refresh: () => { void onRefresh() },
              })
            }}
            onClose={() => { overlays.closeIf('fixupInto') }}
          />
        ) : null}
        {overlay?.kind === 'tagSheet' ? (
          <TagSheet
            key={`${overlay.mode}:${overlay.name}`}
            mode={overlay.mode}
            name={overlay.name}
            loadRemotes={() => client.remoteList({ sessionId })}
            actions={actions}
            onOutcome={(outcome) => { reportOutcome(outcome); void refreshAll() }}
            onClose={() => { overlays.closeIf('tagSheet') }}
          />
        ) : null}
        {overlay?.kind === 'remoteBranchDelete' ? (
          <RemoteBranchDeleteSheet
            ref_={overlay.ref}
            actions={actions}
            onOutcome={(outcome) => { reportOutcome(outcome); void refreshAll() }}
            onClose={() => { overlays.closeIf('remoteBranchDelete') }}
          />
        ) : null}
        {overlay?.kind === 'upstreamSheet' ? (
          <UpstreamSheet
            branch={overlay.branch}
            upstream={overlay.upstream}
            remoteBranches={(branches.value?.remote ?? []).map(entry => entry.name)}
            actions={actions}
            onOutcome={(outcome) => { reportOutcome(outcome); void refreshAll() }}
            onClose={() => { overlays.closeIf('upstreamSheet') }}
          />
        ) : null}
        {overlay?.kind === 'worktreeAdd' ? (
          <WorktreeAddSheet
            branch={overlay.branch}
            actions={actions}
            onAdded={() => { void refreshAll() }}
            onClose={() => { overlays.closeIf('worktreeAdd') }}
          />
        ) : null}
        {overlay?.kind === 'remotes' ? (
          <RemotesPage
            load={() => client.remoteList({ sessionId })}
            actions={actions}
            onBack={() => { overlays.close() }}
            onChanged={() => { void refreshAll() }}
          />
        ) : null}
        {overlay?.kind === 'worktrees' ? (
          <WorktreesPage
            load={() => client.worktreeList({ sessionId })}
            actions={actions}
            version={value.version}
            onAdd={(trigger) => { overlays.open({ kind: 'worktreeAdd' }, trigger) }}
            onBack={() => { overlays.close() }}
          />
        ) : null}
        {overlay?.kind === 'shelve' ? (
          <ShelveSheet
            paths={overlay.paths}
            actions={actions}
            onShelved={() => { void onRefresh(); void shelfStore.refresh() }}
            onClose={() => { overlays.closeIf('shelve') }}
          />
        ) : null}
        {overlay?.kind === 'patch' ? (
          <PatchPage
            shas={overlay.shas}
            load={(shas, signal) => client.formatPatch({ sessionId, shas }, signal)}
            onBack={() => { overlays.close() }}
          />
        ) : null}
        {overlay?.kind === 'applyPatch' ? (
          <ApplyPatchPage
            actions={actions}
            onBack={() => { overlays.close() }}
            onApplied={() => { void onRefresh() }}
          />
        ) : null}
        {overlay?.kind === 'interactiveRebase' ? (
          <InteractiveRebasePage
            sessionId={sessionId}
            base={overlay.base}
            preset={overlay.preset}
            load={(request, signal) => client.rebasePlan(request, signal)}
            actions={actions}
            onBack={() => { overlays.close() }}
            onDone={(result, trigger) => {
              afterInteractiveRebase(result, {
                openConflicts: () => { overlays.open({ kind: 'conflicts' }, trigger) },
                close: () => { overlays.closeIf('interactiveRebase') },
                refresh: () => { void onRefresh() },
              })
            }}
          />
        ) : null}
        {push === null || value.repoRoot === null ? null : (
          <PushPage
            sessionId={sessionId}
            repoRoot={value.repoRoot}
            client={client}
            readOnlyReason={readOnlyReason}
            {...(push.autoSubmit === true ? { autoSubmit: true } : {})}
            {...(push.revision === undefined ? {} : { revision: push.revision })}
            onClose={() => { overlays.closeIf('push') }}
            onPushed={() => { void onRefresh() }}
            onConflict={pushConflictWiring({
              open: overlays.open,
              refresh: () => { void onRefresh() },
              openConsole: () => { setConsoleOpen(true) },
            })}
            onShowConsole={() => { setConsoleOpen(true) }}
            onCopy={text => { void globalThis.navigator?.clipboard?.writeText(text) }}
          />
        )}
        {rollback === null ? null : (
          <RollbackSheet
            sessionId={sessionId}
            targets={rollback}
            client={client}
            readOnlyReason={readOnlyReason}
            onClose={() => { overlays.closeIf('rollback') }}
            onDone={() => { void onRefresh() }}
            onShowConsole={() => { setConsoleOpen(true) }}
            onCopy={text => { void globalThis.navigator?.clipboard?.writeText(text) }}
          />
        )}
        {overlay?.kind !== 'branchSheet' ? null : (
          <BranchSheet
            key={`${overlay.mode}:${overlay.branch ?? ''}:${overlay.startPoint ?? ''}:${overlay.revision ?? ''}`}
            overlay={overlay}
            actions={actions}
            runner={branchRunner}
            onOutcome={reportOutcome}
            onClose={() => { overlays.closeIf('branchSheet') }}
          />
        )}
        {overlay?.kind !== 'smartCheckout' ? null : (
          <SmartCheckoutSheet
            key={`${overlay.target.kind}:${overlay.target.name}`}
            target={overlay.target}
            paths={overlay.paths}
            {...(overlay.untracked === undefined ? {} : { untracked: overlay.untracked })}
            actions={actions}
            onOutcome={reportOutcome}
            onClose={() => { overlays.closeIf('smartCheckout') }}
          />
        )}
        {overlay?.kind !== 'merge' && overlay?.kind !== 'rebase' ? null : (
          <MergePage
            key={overlay.kind}
            mode={overlay.kind}
            preselect={overlay.kind === 'merge' ? overlay.ref : overlay.onto}
            branches={branches.value}
            current={status?.branch ?? null}
            block={integrateBlock}
            actions={actions}
            onOutcome={reportOutcome}
            onNotice={setNotice}
            onClose={() => { overlays.closeIf(overlay.kind) }}
          />
        )}
        {overlay?.kind !== 'pull' ? null : (
          <PullPage
            prefill={{ remote: overlay.remote, branch: overlay.branch }}
            branches={branches.value}
            block={integrateBlock}
            loadRemotes={() => client.pushPreview(sessionId)}
            actions={actions}
            onOutcome={reportOutcome}
            onNotice={setNotice}
            onClose={() => { overlays.closeIf('pull') }}
          />
        )}
        {overlay?.kind !== 'updateProject' ? null : (
          <UpdateProjectPage
            status={status}
            block={integrateBlock}
            actions={actions}
            onOutcome={reportOutcome}
            onNotice={setNotice}
            onClose={() => { overlays.closeIf('updateProject') }}
          />
        )}
        {overlay?.kind !== 'reset' ? null : (
          <ResetSheet
            key={overlay.sha}
            sha={overlay.sha}
            loadPreview={request => client.resetPreview({ sessionId, ...request })}
            actions={actions}
            onOutcome={reportOutcome}
            onClose={() => { overlays.closeIf('reset') }}
          />
        )}
        {overlay?.kind !== 'fetch' ? null : (
          <FetchSheet
            loadRemotes={() => client.pushPreview(sessionId)}
            actions={actions}
            onClose={() => { overlays.closeIf('fetch') }}
          />
        )}
        {overlay?.kind !== 'commitOp' ? null : (
          <CommitOpSheet
            key={`${overlay.op}:${overlay.sha}`}
            op={overlay.op}
            sha={overlay.sha}
            shortSha={overlay.shortSha}
            subject={overlay.subject}
            actions={actions}
            onOutcome={reportOutcome}
            onNotice={setNotice}
            onClose={() => { overlays.closeIf('commitOp') }}
          />
        )}
        {overlay?.kind !== 'stashCreate' ? null : (
          <StashCreateSheet
            branch={status?.branch ?? '(no branch)'}
            block={integrateBlock}
            actions={actions}
            onOutcome={(outcome) => {
              reportOutcome(outcome)
              void stashStore.refresh()
            }}
            onNotice={setNotice}
            onClose={() => { overlays.closeIf('stashCreate') }}
          />
        )}
        {overlay?.kind !== 'conflicts' ? null : (
          <ConflictsPage
            store={conflictStore}
            actions={actions}
            mergeMessage={commit.mode === 'merge' && commit.operationEdited ? commit.operationMessage : ''}
            blockReason={blockText(fetchBlock)}
            loadCommand={() => client.conflictCommand(sessionId)}
            copy={(command) => { void globalThis.navigator?.clipboard?.writeText(command) }}
            onFinished={applyOperationOutcome}
            onAbort={(trigger) => { runOperationControl('abort', trigger) }}
            {...(mergeEnabled
              ? {
                  onOpenFile: openMergeWindow,
                  merge: { loadFile: path => client.mergeFile({ sessionId, path }), onReview: startReview },
                }
              : {})}
            onClose={() => { overlays.closeIf('conflicts') }}
          />
        )}
        {overlay?.kind !== 'mergeWindow' || !mergeEnabled ? null : (
          <MergeWindow
            path={overlay.path}
            store={mergeStore}
            actions={actions}
            operation={operationValue}
            blockReason={blockText(fetchBlock)}
            sidebar={props.sidebar}
            loadCommand={() => client.conflictCommand(sessionId)}
            copy={(command) => { void globalThis.navigator?.clipboard?.writeText(command) }}
            onClose={() => {
              void conflictStore.refresh()
              overlays.open({ kind: 'conflicts' }, null)
            }}
            onOpenFile={review.openFile}
            onResolved={(path) => { review.applied(path, null) }}
            leaveGuard={mergeLeaveGuard}
          />
        )}
        {overlay?.kind !== 'dirtyWorktree' || actionState.ask === null ? null : (
          <DirtyWorktreeSheet
            ask={actionState.ask}
            onStash={dirtyHandlers.onStash}
            onCancel={dirtyHandlers.onCancel}
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
