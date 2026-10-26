/**
 * T7 render check (AC10): key screens rendered with the English translator contain no Chinese,
 * and the same screens in Chinese still read as before. Fixture data is ASCII on purpose, so any
 * CJK in the markup can only come from a string that bypassed the dictionaries.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ConsoleDrawer } from '../../src/client/console/ConsoleDrawer.tsx'
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
