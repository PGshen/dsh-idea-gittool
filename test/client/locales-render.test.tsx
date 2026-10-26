/**
 * T7 render check (AC10): key screens rendered with the English translator contain no Chinese,
 * and the same screens in Chinese still read as before. Fixture data is ASCII on purpose, so any
 * CJK in the markup can only come from a string that bypassed the dictionaries.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ConsoleDrawer } from '../../src/client/console/ConsoleDrawer.tsx'
import { ActionNotice } from '../../src/client/pages/ActionNotice.tsx'
import { BranchContextMenu } from '../../src/client/pages/BranchPanel.tsx'
import { BranchAbortConfirm, BranchesPage } from '../../src/client/pages/BranchesPage.tsx'
import { BranchSheetView } from '../../src/client/pages/BranchSheets.tsx'
import { CommitContextMenu } from '../../src/client/pages/CommitContextMenu.tsx'
import { CommitOpSheetView } from '../../src/client/pages/CommitOpSheet.tsx'
import { ConflictsPageView } from '../../src/client/pages/ConflictsPage.tsx'
import type { ConflictsPageViewProps } from '../../src/client/pages/ConflictsPage.tsx'
import { DirtyWorktreeSheetView } from '../../src/client/pages/DirtyWorktreeSheet.tsx'
import { FetchSheetView } from '../../src/client/pages/FetchSheet.tsx'
import { MergePageView } from '../../src/client/pages/MergePage.tsx'
import { OperationBannerView } from '../../src/client/pages/OperationBanner.tsx'
import { PullPageView } from '../../src/client/pages/PullPage.tsx'
import { ResetSheetView } from '../../src/client/pages/ResetSheet.tsx'
import { SmartCheckoutSheetView } from '../../src/client/pages/SmartCheckoutSheet.tsx'
import { UpdateProjectPageView } from '../../src/client/pages/UpdateProjectPage.tsx'
import { branchActions, quickActions } from '../../src/client/pages/branch-actions.ts'
import { commitActions } from '../../src/client/pages/commit-actions.ts'
import { actionErrorText } from '../../src/client/store/action-store.ts'
import type { OperationStateValue } from '../../src/shared/protocol.ts'
import { mergeState, stashPopState } from './pages/operation-fixtures.ts'
import { createConsoleStore } from '../../src/client/console/console-store.ts'
import { BranchPanel } from '../../src/client/pages/BranchPanel.tsx'
import { ChangesTree } from '../../src/client/pages/ChangesTree.tsx'
import { CommitDetail } from '../../src/client/pages/CommitDetail.tsx'
import { CommitPanel } from '../../src/client/pages/CommitPanel.tsx'
import { DiffViewerView } from '../../src/client/pages/DiffViewer.tsx'
import { FilterBar } from '../../src/client/pages/FilterBar.tsx'
import { OperationBanner } from '../../src/client/pages/OperationBanner.tsx'
import { PageTabs } from '../../src/client/pages/PageTabs.tsx'
import { PushPageView } from '../../src/client/pages/PushPage.tsx'
import { PushRejectedView } from '../../src/client/pages/PushRejectedPage.tsx'
import { RepoBar } from '../../src/client/pages/RepoBar.tsx'
import { RollbackSheetView } from '../../src/client/pages/RollbackSheet.tsx'
import { StashCreateSheetView } from '../../src/client/pages/StashCreateSheet.tsx'
import { StashPageView } from '../../src/client/pages/StashPage.tsx'
import { StatusBar } from '../../src/client/pages/StatusBar.tsx'
import { ReadOnlyBanner } from '../../src/client/read-only-banner.tsx'
import { text } from '../../src/client/localized-text.ts'
import type { Translate } from '../../src/client/localized-text.ts'
import { createChangesStore } from '../../src/client/store/changes-store.ts'
import { createCommitStore } from '../../src/client/store/commit-store.ts'
import { DEFAULT_LOG_FILTER } from '../../src/client/store/log-store.ts'
import { defaultPushForm } from '../../src/client/store/push-store.ts'
import type { PushState } from '../../src/client/store/push-store.ts'
import type { CommitDetailValue, PushPreviewValue } from '../../src/shared/protocol.ts'
import { failedRecord, record } from './console/console-fixtures.ts'
import { enT, withLocale, zhT } from './i18n-helpers.tsx'
import { branchesFixture } from './pages/branch-fixtures.ts'
import { mixedStatus } from './pages/changes-fixtures.ts'

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const NOW = Date.parse('2026-10-26T10:00:00Z')

const DETAIL: CommitDetailValue = {
  sha: '7f3a2c1d4e5f60718293a4b5c6d7e8f901234567',
  shortSha: '7f3a2c1d',
  parents: [],
  author: { name: 'Alice', email: 'alice@example.com', date: '2026-10-24T10:00:00Z' },
  committer: { name: 'Bob', email: 'bob@example.com', date: '2026-10-25T10:00:00Z' },
  subject: 'feat: login',
  body: 'line\n'.repeat(30),
  refs: [],
  files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }],
  truncated: true,
}

const PREVIEW: PushPreviewValue = {
  remotes: ['origin'],
  branch: null,
  detached: true,
  upstream: null,
  defaultRemote: 'origin',
  commits: [],
  truncated: false,
}

function pushState(overrides: Partial<PushState> = {}): PushState {
  return {
    view: 'push',
    previewStatus: 'ready',
    preview: PREVIEW,
    previewError: null,
    form: { ...defaultPushForm(PREVIEW, null), forceWithLease: true },
    busy: null,
    error: { code: 'git/auth-required', message: 'auth', details: { command: 'git push origin HEAD:main' } },
    rejected: null,
    rejectedFromPush: false,
    choice: 'force',
    choiceRiskConfirmed: false,
    autoRetryRejected: true,
    ...overrides,
  }
}

const noop = (): void => {}


const A3_SHA = 'a'.repeat(40)
const A3_CONTEXT = { writable: true, operation: 'merge' as const, current: 'main', dirty: true }

function conflicts(t: Translate, value: OperationStateValue, extra: Partial<ConflictsPageViewProps> = {}): ReactNode {
  return (
    <ConflictsPageView
      t={t}
      state={{ status: 'ready', value, error: null }}
      busyPath={null}
      markersPath="src/a.ts"
      error={text('action.error.empty')}
      copied
      finishBusy={false}
      onResolve={noop} onConfirmMarkers={noop} onCancelMarkers={noop} onClose={noop}
      onFinish={noop} onCopyCommand={noop} onRetry={noop}
      onAbortRequest={noop} onAbortCancel={noop} onAbort={noop}
      {...extra}
    />
  )
}

/** Screens added by A3 (branches, integrate, conflicts, T11 copy). */
const A3_SCREENS: Record<string, (t: Translate) => ReactNode> = {
  branchesPage: () => (
    <BranchesPage
      value={branchesFixture()} context={A3_CONTEXT} search="" collapsedGroups={{ head: false, local: false, remote: false, tags: false }}
      collapsedDirs={{}} flat={false} error={{ code: 'git/timeout', message: 'slow' }} fetching
      onSearchChange={noop} onToggleGroup={noop} onToggleDirectory={noop} onAction={noop} onQuickAction={noop} onFetch={noop}
    />
  ),
  branchMenus: () => {
    const login = branchesFixture().local[1] ?? branchesFixture().local[0]!
    const commit = { sha: A3_SHA, shortSha: 'aaaaaaa', parents: ['b'.repeat(40), 'c'.repeat(40)], author: 'a', email: 'e', date: '', subject: 's' }
    return (
      <>
        <BranchContextMenu entry={login} items={branchActions(login, { ...A3_CONTEXT, operation: 'rebase' })} onSelect={noop} />
        <CommitContextMenu commit={commit} items={commitActions(commit, { writable: true, operation: null, parentLoaded: true, childLoaded: false })} onSelect={noop} />
        <ActionNotice notice={{ tone: 'warning', message: text('notice.stashKept'), action: 'goStash' }} onDismiss={noop} onAction={noop} />
        <ActionNotice notice={{ tone: 'error', message: text('write.tooManyPaths', { max: 2000, count: 2001 }) }} onDismiss={noop} />
        <span>{quickActions(A3_CONTEXT).length}</span>
      </>
    )
  },
  branchSheets: t => (
    <>
      <BranchSheetView t={t} overlay={{ kind: 'branchSheet', mode: 'new', startPoint: 'feat/login' }} form={{ name: 'a b', checkout: true, revision: '', force: false, forceConfirmed: false }} busy={false} error={null} onChange={noop} onSubmit={noop} onCancel={noop} />
      <BranchSheetView t={t} overlay={{ kind: 'branchSheet', mode: 'delete', branch: 'feat/login', sha: A3_SHA }} form={{ name: '', checkout: true, revision: '', force: true, forceConfirmed: false }} busy={false} error={actionErrorText({ code: 'git/not-merged', message: 'x', details: { branch: 'feat/login' } })} onChange={noop} onSubmit={noop} onCancel={noop} />
      <BranchAbortConfirm t={t} operation="rebase" onCancel={noop} onConfirm={noop} />
    </>
  ),
  smartCheckout: t => (
    <>
      <SmartCheckoutSheetView t={t} target={{ kind: 'local', name: 'feat/login' }} paths={['a.ts']} untracked={['out.js']} forceConfirmed={false} busy={false} error={null} onStash={noop} onForce={noop} onCancel={noop} onForceConfirmChange={noop} />
      <SmartCheckoutSheetView t={t} target={{ kind: 'local', name: 'feat/login' }} paths={[]} untracked={['out.js']} forceConfirmed busy={false} error={null} onStash={noop} onForce={noop} onCancel={noop} onForceConfirmChange={noop} />
    </>
  ),
  dirtyWorktree: t => (
    <DirtyWorktreeSheetView t={t} ask={{ key: 'merge:x', endpoint: 'merge', operation: 'merge', paths: ['a.ts'], count: 12, trigger: null }} onStash={noop} onCancel={noop} />
  ),
  integratePages: t => (
    <>
      <MergePageView t={t} mode="merge" current="main" options={['feat/login']} form={{ target: 'feat/login', option: 'squash' }} busy={false} error={null} block={text('branch.disabled.readOnly')} onChange={noop} onSubmit={noop} onBack={noop} />
      <MergePageView t={t} mode="rebase" current="main" options={['origin/main']} form={{ target: 'origin/main', option: 'default' }} busy error={null} onChange={noop} onSubmit={noop} onBack={noop} />
      <PullPageView t={t} loading={false} loadError={null} remotes={['origin']} branchOptions={['main']} form={{ remote: 'origin', branch: 'main', mode: 'rebase' }} busy={false} error={null} onChange={noop} onSubmit={noop} onBack={noop} onRetry={noop} />
      <UpdateProjectPageView t={t} mode="merge" stashNote noUpstream rewritten={null} backup busy={false} error={null} onModeChange={noop} onBackupChange={noop} onSubmit={noop} onResetToRemote={noop} onBack={noop} />
    </>
  ),
  updateRewritten: t => (
    <>
      <UpdateProjectPageView t={t} mode="merge" stashNote={false} noUpstream={false} rewritten={{ localAhead: 3 }} backup busy={false} error={text('integrate.update.resetInTheWay', { count: 1, paths: 'out.js' })} onModeChange={noop} onBackupChange={noop} onSubmit={noop} onResetToRemote={noop} onBack={noop} />
      <UpdateProjectPageView t={t} mode="merge" stashNote={false} noUpstream={false} rewritten={{ localAhead: 3 }} backup={false} busy={false} error={text('integrate.update.resetDirty', { count: 1 })} onModeChange={noop} onBackupChange={noop} onSubmit={noop} onResetToRemote={noop} onBack={noop} />
    </>
  ),
  integrateSheets: t => (
    <>
      <ResetSheetView
        t={t} sha={A3_SHA} loading={false} loadError={null} form={{ mode: 'hard', hardConfirmed: false }} busy={false} error={null}
        preview={{ head: 'h'.repeat(40), discardCount: 3, truncated: true, commitsLost: [{ sha: 'c'.repeat(40), shortSha: 'ccccccc', parents: [], author: 'a', email: 'e', date: '2026-10-25T00:00:00Z', subject: 'lost commit' }] }}
        onChange={noop} onSubmit={noop} onCancel={noop} onRetry={noop}
      />
      <FetchSheetView t={t} remotes={['origin']} loading={false} form={{ remote: null, prune: true }} busy={false} error={null} result={null} onChange={noop} onSubmit={noop} onCancel={noop} />
      <CommitOpSheetView t={t} op="cherryPick" shortSha="aaaaaaa" subject="feat: x" busy={false} error={text('action.error.empty.abortOnly')} onSubmit={noop} onCancel={noop} />
    </>
  ),
  banner: t => (
    <OperationBannerView t={t} operation="cherry-pick" conflicts={1} branch="main" step={{ current: 1, total: 2 }} pendingStash confirmingAbort onAbortRequest={noop} onAbortCancel={noop} onResolve={noop} onContinue={noop} onSkip={noop} onAbort={noop} onOpenConsole={noop} />
  ),
  conflictsMerge: t => conflicts(t, mergeState(), { abortConfirming: true }),
  conflictsStashPop: t => conflicts(t, stashPopState(), { markersPath: null }),
  rollbackResult: t => (
    <RollbackSheetView
      t={t}
      targets={[{ path: 'a.ts', untracked: false }, { path: 'b.md', untracked: true }]}
      state={{ deleteConfirmed: true, busy: false, error: null, result: { restored: [], deleted: ['b.md'], keptStaged: [], skipped: ['a.ts'] } }}
      readOnlyReason={null}
      onCancel={noop} onDeleteConfirmedChange={noop} onSubmit={noop} onCopy={noop}
    />
  ),
}

/** Screens covering every page area; each returns its markup for one translator. */
const SCREENS: Record<string, (t: Translate) => ReactNode> = {
  filterBar: () => (
    <FilterBar
      query=""
      filter={{ ...DEFAULT_LOG_FILTER, branches: ['main'], authors: ['Ann'], order: 'topo', firstParent: true, noMerges: true }}
      branchOptions={[{ name: 'main', kind: 'local' }, { name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }]}
      authorOptions={[]}
      jumpError={text('log.jump.notInView', { target: 'v1', count: 3 })}
      onQueryChange={noop}
      onQueryCommit={noop}
      onQueryClear={noop}
      onFilterChange={noop}
      onJump={() => false}
      onJumpEdit={noop}
      onRefresh={noop}
    />
  ),
  detail: () => <CommitDetail detail={DETAIL} status="ready" error={null} now={NOW} />,
  detailError: () => <CommitDetail detail={null} status="error" error={{ code: 'git/exec-failed', message: 'boom' }} onRetry={noop} />,
  diff: t => (
    <DiffViewerView
      t={t}
      request={{ sessionId: 's', scope: 'staged', path: 'bin.png' }}
      state={{ request: null, status: 'ready', value: { oldPath: 'bin.png', newPath: 'bin.png', status: 'M', binary: true, hunks: [], truncated: false, oldSize: 10, newSize: 20 }, error: null }}
      files={[{ path: 'bin.png', status: 'M' }, { path: 'b.ts', status: 'A' }]}
      position={{ index: 0, total: 2, hasPrev: false, hasNext: true }}
      source={[text('diff.source.commit'), text('diff.source.staged')]}
      onClose={noop}
      onPrev={noop}
      onNext={noop}
      onSelectFile={noop}
      onCopy={noop}
      onRetry={noop}
      onKeyDown={noop}
    />
  ),
  branches: () => (
    <BranchPanel
      value={{ ...branchesFixture(), truncated: true }}
      mode="standard"
      open
      search=""
      collapsedGroups={{ head: false, local: false, remote: false, tags: false }}
      collapsedDirs={{}}
      flat={false}
      error={{ code: 'git/timeout', message: 'slow' }}
      onNavigate={noop}
      onFilter={noop}
      onClose={noop}
      onRetry={noop}
      onOpenConsole={noop}
    />
  ),
  stash: () => (
    <StashPageView
      state={{
        list: { status: 'ready', entries: [{ sha: 'a'.repeat(40), index: 0, message: 'WIP on main: aaaaaaa feat', branch: 'main', date: '2026-10-26T07:00:00Z', fileCount: 2 }], version: 1, error: null },
        selectedSha: 'a'.repeat(40),
        files: { status: 'ready', sha: 'a'.repeat(40), value: { sha: 'a'.repeat(40), parentSha: 'b'.repeat(40), untrackedSha: null, files: [{ path: 'src/a.ts', status: 'M' }], untracked: [] }, error: null },
      }}
      now={NOW}
      busy={false}
      confirmingSha={'a'.repeat(40)}
      onSelect={noop} onPreview={noop} onCreate={noop} onApply={noop} onAskDrop={noop}
      onCancelDrop={noop} onConfirmDrop={noop} onOpenFile={noop} onRetry={noop}
    />
  ),
  stashCreate: (t) => (
    <StashCreateSheetView
      t={t} branch="main" form={{ message: '', includeUntracked: false, keepIndex: false }}
      busy={false} error={text('stash.nothing')} onChange={noop} onSubmit={noop} onCancel={noop}
    />
  ),
  shell: () => (
    <>
      <RepoBar repoRoot={null} mode="compact" onToggleBranches={noop} onRefresh={noop} onOpenConsole={noop} consoleHasErrors defaultMenuOpen />
      <OperationBanner operation="rebase" conflicts={2} branch="main" onOpenConsole={noop} />
      <ReadOnlyBanner policy={{ mode: 'read-only', reason: '仓库根不在沙箱工作区内', reasonCode: 'repo-outside-workspace' }} />
      <PageTabs page="commit" onChange={noop} uncommittedCount={3} />
      <StatusBar status={mixedStatus({ operation: 'merge' })} stashCount={null} lastRefreshAt={null} autoRefresh onToggleAutoRefresh={noop} />
    </>
  ),
  console: () => {
    const store = createConsoleStore({ load: async () => ({ ok: true, value: { records: [], truncated: false } }) })
    store.apply({ records: [record(), failedRecord(), record({ exitCode: null, timedOut: true, stdoutTruncated: true })], truncated: true })
    return <ConsoleDrawer state={store.getState()} onClose={noop} onClear={noop} onPausedChange={noop} onToggleExpanded={noop} />
  },
  commit: () => {
    const changesStore = createChangesStore()
    changesStore.setStatus(mixedStatus())
    const commitStore = createCommitStore({
      sessionId: 's',
      repoRoot: '/r',
      client: { commitFiles: async () => ({ ok: true, value: { sha: 'a', shortSha: 'a' } }), amendMessage: async () => ({ ok: true, value: { sha: 'a', shortSha: 'a' } }) },
      storage: null,
    })
    commitStore.setAmend(true)
    return (
      <>
        <ChangesTree state={changesStore.getState()} store={changesStore} onOpenDiff={noop} />
        <CommitPanel
          changesStore={changesStore}
          changes={changesStore.getState()}
          commitStore={commitStore}
          commit={commitStore.getState()}
          status={mixedStatus({ detached: true, operation: 'merge' })}
          writePolicy={{ mode: 'read-write' }}
          onOpenDiff={noop}
          onShowConsole={noop}
        />
      </>
    )
  },
  push: t => (
    <PushPageView t={t} state={pushState()} readOnlyReason={null} onClose={noop} onRetryLoad={noop} onFormChange={noop} onSubmit={noop} onCopy={noop} onShowConsole={noop} />
  ),
  rejected: t => (
    <PushRejectedView
      t={t}
      state={pushState({
        view: 'rejected',
        busy: 'retry',
        rejected: { reason: 'stale-lease', remote: 'origin', branch: 'main', remoteCommits: [], summary: '[rejected] main (stale info)' },
      })}
      readOnlyReason="read-only"
      onBack={noop}
      onCancel={noop}
      onChoice={noop}
      onRiskChange={noop}
      onSubmit={noop}
      onCopy={noop}
    />
  ),
  rollback: t => (
    <RollbackSheetView
      t={t}
      targets={[{ path: 'a.ts', untracked: false }, { path: 'b.md', untracked: true }]}
      state={{ deleteConfirmed: false, busy: false, error: { code: 'git/locked', message: 'locked' }, result: null }}
      readOnlyReason={null}
      onCancel={noop}
      onDeleteConfirmedChange={noop}
      onSubmit={noop}
      onCopy={noop}
    />
  ),
}

Object.assign(SCREENS, A3_SCREENS)

function html(name: string, t: Translate): string {
  const screen = SCREENS[name]
  if (screen === undefined) throw new Error(name)
  return renderToStaticMarkup(withLocale(screen(t), t))
}

describe('English rendering leaves no Chinese behind', () => {
  for (const name of Object.keys(SCREENS)) {
    it(name, () => {
      const markup = html(name, enT)
      expect(markup.match(CJK) ?? []).toEqual([])
      // The same screen in Chinese really does carry translated copy (the probe is meaningful).
      expect(html(name, zhT)).toMatch(CJK)
    })
  }

  it('the read-only banner uses the localized text for the Host reason code', () => {
    const markup = html('shell', enT)
    expect(markup).toContain('The repository root is outside the sandbox workspace')
    expect(markup).not.toContain('仓库根不在沙箱工作区内')
  })

  it('the read-only banner falls back to the Host reason when no code is sent', () => {
    const markup = renderToStaticMarkup(withLocale(<ReadOnlyBanner policy={{ mode: 'read-only', reason: 'legacy reason' }} />, enT))
    expect(markup).toContain('Read-only')
    expect(markup).toContain('legacy reason')
  })

  it('the jump failure is visible text under the jump box in both languages', () => {
    expect(html('filterBar', enT)).toContain('&quot;v1&quot; is not in the current view (3 rows loaded)')
    expect(html('filterBar', zhT)).toContain('「v1」不在当前视图中（已加载 3 行）')
  })
})
