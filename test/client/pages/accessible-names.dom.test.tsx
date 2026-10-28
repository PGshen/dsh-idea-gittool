// @vitest-environment happy-dom
// B4b T7: accessible-name audit (WCAG 2.5.3 label-in-name, 4.1.2 name) over the main surfaces.
// Each control's name must contain its visible text (an aria-label may add to it, not replace it),
// and no control may be nameless. A failure lists the offending controls.
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionMenu } from '../../../src/client/pages/ActionMenu.tsx'
import { BranchPanel } from '../../../src/client/pages/BranchPanel.tsx'
import { BranchesPage } from '../../../src/client/pages/BranchesPage.tsx'
import { LogPage } from '../../../src/client/pages/LogPage.tsx'
import { MergeFooter, MergeHeader } from '../../../src/client/pages/MergeWindowParts.tsx'
import { RepoBar } from '../../../src/client/pages/RepoBar.tsx'
import { SettingsSheet } from '../../../src/client/pages/SettingsSheet.tsx'
import { StatusBar } from '../../../src/client/pages/StatusBar.tsx'
import { createLogStore } from '../../../src/client/store/log-store.ts'
import type { CommitSummary, LogValue, RpcResult } from '../../../src/shared/protocol.ts'
import { nameViolations, render, stubLayout } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { enT, withLocale, zhT } from '../i18n-helpers.tsx'
import { branchesFixture, statusFixture } from './branch-fixtures.ts'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null; localStorage.clear() })

const noop = (): void => {}
const expanded = { head: false, local: false, remote: false, tags: false }
const side = { label: 'main', name: 'main', technical: 'ours' }

function commit(index: number): CommitSummary {
  const sha = `c${String(index)}`.padEnd(40, '0')
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'Alice', email: 'a@example.com', date: '2026-10-24T10:00:00+08:00', subject: `subject ${String(index)}` }
}

const surfaces: Array<[string, () => ReactElement]> = [
  ['repo bar', () => <RepoBar repoRoot="/tmp/repo" onRefresh={noop} onOpenConsole={noop} onFetch={noop} onPull={noop} onPush={noop} onSettings={noop} defaultMenuOpen />],
  ['branch panel', () => <BranchPanel value={branchesFixture()} mode="standard" open search="" collapsedGroups={expanded} collapsedDirs={{}} flat={false} onNavigate={noop} onFilter={noop} onClose={noop} />],
  ['branches page', () => <BranchesPage value={branchesFixture()} context={{ writable: false, operation: null, current: 'main', dirty: false }} search="" collapsedGroups={expanded} collapsedDirs={{}} flat={false} onSearchChange={noop} onToggleGroup={noop} onToggleDirectory={noop} onAction={noop} onQuickAction={noop} onFetch={noop} />],
  ['status bar', () => <StatusBar status={statusFixture()} lastRefreshAt={Date.now()} autoRefresh onToggleAutoRefresh={noop} />],
  ['settings sheet', () => <SettingsSheet onClose={noop} />],
  ['merge header', () => <MergeHeader t={zhT} path="a.txt" counts={{ resolved: 1, total: 3 }} hasPrev hasNext canUndo busy={false} blockReason={null} canSave onBack={noop} onPrevFile={noop} onNextFile={noop} onUndo={noop} onSaveClose={noop} />],
  ['merge footer', () => <MergeFooter t={zhT} sides={{ left: side, right: side, note: null }} busy={false} applied={false} blockReason={null} nonConflictingOpen onAction={noop} onToggleNonConflicting={noop} onApply={noop} />],
  ['action menu', () => <ActionMenu label="m" items={[{ id: 'a', label: { key: 'action.refresh' }, section: 0 }, { id: 'b', label: { key: 'action.retry' }, disabledReason: { key: 'branch.disabled.readOnly' }, section: 0 }]} onSelect={noop} onClose={noop} />],
]

describe('nameViolations', () => {
  it('flags an aria-label that drops the visible text and a nameless control; accepts symbols, extra words and titles', () => {
    view = render(
      <div>
        <button type="button" aria-label="Write Result back">应用更改</button>
        <button type="button" />
        <button type="button" aria-label="More actions">⋯</button>
        <button type="button" aria-label="应用更改（写回工作区）">应用更改</button>
        <button type="button" title="Close">✕</button>
      </div>,
    )
    expect(nameViolations(view.container)).toEqual([
      'button "应用更改" is named "Write Result back" (does not contain its visible text)',
      'button "<button type="button"></button>" has no accessible name',
    ])
  })
})

describe('accessible names (DOM)', () => {
  it.each(surfaces)('%s: every control is named and its name contains its visible text', (_name, ui) => {
    view = render(withLocale(ui()) as ReactElement)
    expect(nameViolations(view.container)).toEqual([])
  })

  it.each(surfaces)('%s (English): same rule', (_name, ui) => {
    view = render(withLocale(ui(), enT) as ReactElement)
    expect(nameViolations(view.container)).toEqual([])
  })

  it('log page', async () => {
    const restore = stubLayout({ width: 600, height: 520 })
    const value: LogValue = { commits: [commit(0), commit(1)], truncated: false }
    const store = createLogStore({ sessionId: 's', loadPage: async (): Promise<RpcResult<LogValue>> => ({ ok: true, value }) })
    await store.loadFirstPage()
    view = render(withLocale(<LogPage store={store} autoLoad={false} viewportHeight={520} />) as ReactElement)
    expect(nameViolations(view.container)).toEqual([])
    restore()
  })
})
