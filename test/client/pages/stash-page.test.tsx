// A3 T10 stash page and create sheet (views are hook-free, so static rendering shows their gating).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { escapeHandler } from '../../../src/client/pages/integrate-parts.tsx'
import { StashCreateSheetView, stashCreateCanSubmit } from '../../../src/client/pages/StashCreateSheet.tsx'
import { StashPageView, stashFileOpen } from '../../../src/client/pages/StashPage.tsx'
import { ActionNotice } from '../../../src/client/pages/ActionNotice.tsx'
import { PageTabs, adjacentPage, badgeText } from '../../../src/client/pages/PageTabs.tsx'
import { OVERLAY_LEVEL } from '../../../src/client/pages/workbench-overlay.ts'
import { text } from '../../../src/client/localized-text.ts'
import { stashNotice } from '../../../src/client/pages/operation-actions.ts'
import { outcomeNotice } from '../../../src/client/pages/branch-actions.ts'
import type { StashStoreState } from '../../../src/client/store/stash-store.ts'
import type { StashEntry, StashFilesValue } from '../../../src/shared/protocol.ts'
import { en, zh } from '../../../src/client/locales.ts'
import { zhT } from '../i18n-helpers.tsx'

const noop = (): void => {}
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const NOW = Date.parse('2026-10-26T12:00:00.000Z')

function entry(sha: string, index: number, overrides: Partial<StashEntry> = {}): StashEntry {
  return { sha, index, message: `WIP on main: ${sha.slice(0, 7)} feat: log`, branch: 'main', date: '2026-10-26T07:00:00.000Z', fileCount: 3, ...overrides }
}

const FILES: StashFilesValue = {
  sha: SHA_A,
  parentSha: 'd'.repeat(40),
  untrackedSha: 'e'.repeat(40),
  files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
  untracked: [{ path: 'notes/new.txt', status: '?' }],
}

function state(overrides: Partial<StashStoreState> = {}): StashStoreState {
  return {
    list: { status: 'ready', entries: [entry(SHA_A, 0), entry(SHA_B, 1, { branch: null })], version: 1, error: null },
    selectedSha: SHA_A,
    files: { status: 'ready', sha: SHA_A, value: FILES, error: null },
    ...overrides,
  }
}

function view(extra: Record<string, unknown> = {}, current: StashStoreState = state()): string {
  return renderToStaticMarkup(
    <StashPageView
      state={current}
      now={NOW}
      busy={false}
      confirmingSha={null}
      onSelect={noop} onPreview={noop} onCreate={noop} onApply={noop} onAskDrop={noop}
      onCancelDrop={noop} onConfirmDrop={noop} onOpenFile={noop} onRetry={noop}
      {...extra}
    />,
  )
}

describe('StashPageView', () => {
  it('lists message, source branch, file count and relative time per stash', () => {
    const html = view()
    expect(html).toContain('WIP on main: aaaaaaa feat: log')
    expect(html).toContain('来自 main')
    expect(html).toContain('3 个文件')
    expect(html).toContain('5 小时前')
    expect(html).toContain('来源分支未知')
    expect(html).toContain(`data-sha="${SHA_A}"`)
    expect(html).toContain('贮藏 (2)')
  })

  it('omits the file count when the Host left it out (more than 50 entries)', () => {
    const html = view({}, state({ list: { status: 'ready', entries: [entry(SHA_A, 0, { fileCount: undefined as never })], version: 1, error: null } }))
    const list = html.slice(html.indexOf('role="listbox"'), html.indexOf('data-stash-files'))
    expect(list).not.toContain('个文件</')
  })

  it('selected row is marked and its tracked and untracked files are shown', () => {
    const html = view()
    expect(html).toMatch(/data-sha="a{40}"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-sha="a{40}"/)
    expect(html).toContain('已跟踪的改动')
    expect(html).toContain('未跟踪的文件')
    expect(html).toContain('data-path="src/a.ts"')
    expect(html).toContain('data-path="notes/new.txt"')
  })

  it('says when the file list was truncated by the Host (final review 4)', () => {
    expect(view()).not.toContain('data-stash-truncated')
    const html = view({}, state({ files: { status: 'ready', sha: SHA_A, value: { ...FILES, truncated: true }, error: null } }))
    expect(html).toContain('data-stash-truncated')
    expect(html).toContain('文件过多，只显示了前 2 个。')
  })

  it('has the create / apply / pop / delete actions; the last three need a selection', () => {
    const html = view()
    for (const id of ['create', 'apply', 'pop', 'drop']) expect(html).toContain(`data-stash-action="${id}"`)
    const none = view({}, state({ selectedSha: null, files: { status: 'idle', sha: null, value: null, error: null } }))
    expect(none).toMatch(/data-stash-action="apply"[^>]*disabled|disabled[^>]*data-stash-action="apply"/)
    expect(none).toContain(zh['stash.selectFirst'])
  })

  it('a write block disables create / apply / pop with its reason; drop has its own block', () => {
    const html = view({ block: text('branch.disabled.readOnly') })
    expect(html).toContain(zh['branch.disabled.readOnly'])
    expect(html).toMatch(/data-stash-action="create"[^>]*disabled|disabled[^>]*data-stash-action="create"/)
    expect(html).not.toMatch(/data-stash-action="drop"[^>]*disabled=""|disabled=""[^>]*data-stash-action="drop"/)
    const dropBlocked = view({ dropBlock: text('branch.disabled.readOnly') })
    expect(dropBlocked).toMatch(/data-stash-action="drop"[^>]*disabled|disabled[^>]*data-stash-action="drop"/)
  })

  it('busy disables every action', () => {
    expect(view({ busy: true })).toMatch(/data-stash-action="create"[^>]*disabled|disabled[^>]*data-stash-action="create"/)
  })

  it('delete confirmation names the stash message and offers confirm / cancel', () => {
    const html = view({ confirmingSha: SHA_A })
    expect(html).toContain('data-drop-confirm')
    expect(html).toContain('WIP on main: aaaaaaa feat: log')
    expect(html).toContain('data-drop-confirm-ok')
    expect(html).toContain('data-drop-confirm-cancel')
    expect(view()).not.toContain('data-drop-confirm')
  })

  it('empty list shows the empty state with a create button; a load failure offers retry', () => {
    const empty = view({}, state({ list: { status: 'ready', entries: [], version: 1, error: null }, selectedSha: null, files: { status: 'idle', sha: null, value: null, error: null } }))
    expect(empty).toContain('没有贮藏')
    expect(empty).toContain('创建贮藏…')
    const error = view({}, state({ list: { status: 'error', entries: [], version: undefined, error: { code: 'git/timeout', message: 'x' } }, selectedSha: null, files: { status: 'idle', sha: null, value: null, error: null } }))
    expect(error).toContain('git/timeout')
    expect(error).toContain('重试')
  })

  it('shows loading and failure of the files area', () => {
    expect(view({}, state({ files: { status: 'loading', sha: SHA_A, value: null, error: null } }))).toContain('读取中…')
    expect(view({}, state({ files: { status: 'error', sha: SHA_A, value: null, error: { code: 'git/stale-target', message: 'x' } } }))).toContain('git/stale-target')
  })
})

describe('delete confirmation gating and keys', () => {
  it('the confirm button is disabled while blocked or busy, enabled otherwise', () => {
    const open = view({ confirmingSha: SHA_A })
    expect(open).not.toMatch(/data-drop-confirm-ok[^>]*disabled|disabled[^>]*data-drop-confirm-ok/)
    for (const extra of [{ busy: true }, { dropBlock: text('branch.disabled.readOnly') }]) {
      expect(view({ confirmingSha: SHA_A, ...extra })).toMatch(/disabled=""[^>]*data-drop-confirm-ok|data-drop-confirm-ok[^>]*disabled=""/)
    }
  })

  it('Esc on the confirmation cancels it and is consumed', () => {
    const cancel = vi.fn()
    const event = { key: 'Escape', defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    escapeHandler(false, cancel)(event as never)
    expect(cancel).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalled()
    escapeHandler(false, cancel)({ ...event, key: 'Enter' } as never)
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('stashFileOpen', () => {
  const paths = (value: StashFilesValue) => value
  it('double-clicked tracked file: only tracked files are switchable in the diff; untracked uses the root commit', () => {
    const tracked = stashFileOpen('s1', paths(FILES), 'tracked', 'src/a.ts')
    expect(tracked?.request).toEqual({ sessionId: 's1', scope: 'commit', sha: SHA_A, parent: FILES.parentSha, path: 'src/a.ts' })
    expect(tracked?.files.map(file => file.path)).toEqual(['src/a.ts'])
    const untracked = stashFileOpen('s1', FILES, 'untracked', 'notes/new.txt')
    expect(untracked?.request).toEqual({ sessionId: 's1', scope: 'commit', sha: FILES.untrackedSha, path: 'notes/new.txt' })
    expect(untracked?.files.map(file => file.path)).toEqual(['notes/new.txt'])
    expect(stashFileOpen('s1', FILES, 'tracked', 'missing.ts')).toBeNull()
  })
})

describe('StashCreateSheetView', () => {
  const sheet = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <StashCreateSheetView
      t={zhT}
      branch="main"
      form={{ message: '', includeUntracked: false, keepIndex: false }}
      busy={false}
      error={null}
      onChange={noop} onSubmit={noop} onCancel={noop}
      {...extra}
    />,
  )

  it('keep-index hint describes the checked state (W2)', () => {
    expect(sheet()).toContain('勾选后，已暂存的改动在贮藏后仍留在暂存区。')
    expect(en['stash.create.keepIndex.hint']).toBe('When checked, staged changes stay in the index after stashing.')
  })

  it('has the message field with the Host default as placeholder and the two options', () => {
    const html = sheet()
    expect(html).toContain('WIP on main:')
    expect(html).toContain('data-stash-message')
    expect(html).toContain('data-include-untracked')
    expect(html).toContain('data-keep-index')
    expect(html).toContain('data-primary')
  })

  it('shows the nothing-to-stash error and gates submit on busy / block', () => {
    expect(sheet({ error: text('stash.nothing') })).toContain('没有可贮藏的改动')
    expect(stashCreateCanSubmit(undefined, false)).toBe(true)
    expect(stashCreateCanSubmit(undefined, true)).toBe(false)
    expect(stashCreateCanSubmit(text('branch.disabled.readOnly'), false)).toBe(false)
    expect(sheet({ block: text('branch.disabled.readOnly') })).toContain(zh['branch.disabled.readOnly'])
  })
})

describe('stash page wiring', () => {
  it('PageTabs has the stash tab with its own badge (hidden at 0, 99+)', () => {
    const html = renderToStaticMarkup(<PageTabs page="stash" onChange={noop} uncommittedCount={0} stashCount={4} />)
    expect(html).toContain('data-page="stash"')
    expect(html).toContain('>贮藏<')
    expect(html).toContain('data-stash-badge="4"')
    expect(renderToStaticMarkup(<PageTabs page="log" onChange={noop} uncommittedCount={0} stashCount={0} />)).not.toContain('data-stash-badge')
    expect(renderToStaticMarkup(<PageTabs page="log" onChange={noop} uncommittedCount={0} />)).not.toContain('data-stash-badge')
    expect(badgeText(150)).toBe('99+')
    expect(renderToStaticMarkup(<PageTabs page="log" onChange={noop} uncommittedCount={0} stashCount={150} />)).toContain('99+')
    expect(adjacentPage('branches', 'ArrowRight')).toBe('stash')
    expect(adjacentPage('stash', 'ArrowRight')).toBe('log')
  })

  it('stashCreate stays a level-2 sheet', () => {
    expect(OVERLAY_LEVEL.stashCreate).toBe(2)
  })

  it('a kept stash notice links to the stash page', () => {
    expect(stashNotice({ stashKept: true })?.action).toBe('goStash')
    expect(stashNotice({ stashError: 'bad' })?.action).toBe('goStash')
    expect(stashNotice({ stashMissing: true })?.action).toBeUndefined()
    expect(outcomeNotice({ kind: 'done', value: { stashKept: true } })?.action).toBe('goStash')
    const html = renderToStaticMarkup(<ActionNotice notice={{ tone: 'warning', message: text('operation.notice.stashKept'), action: 'goStash' }} onDismiss={noop} onAction={noop} />)
    expect(html).toContain('data-notice-action="goStash"')
    expect(html).toContain('前往贮藏页')
    expect(renderToStaticMarkup(<ActionNotice notice={{ tone: 'warning', message: text('operation.notice.stashKept') }} onDismiss={noop} onAction={noop} />)).not.toContain('data-notice-action')
  })

  it('an error notice shows its stash detail next to the message (final review 2a)', () => {
    const notice = { tone: 'error' as const, message: text('action.error.git/stale-target'), detail: text('operation.notice.stashKept'), action: 'goStash' as const }
    const html = renderToStaticMarkup(<ActionNotice notice={notice} onDismiss={noop} onAction={noop} />)
    expect(html).toContain('data-notice-detail')
    expect(html).toContain(zh['operation.notice.stashKept'])
    expect(html).toContain('data-notice-action="goStash"')
  })
})
