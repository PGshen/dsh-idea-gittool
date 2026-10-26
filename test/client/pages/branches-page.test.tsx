// A3 T7 Branches page (design §8.3): search over branches and actions, quick actions, grouped rows,
// `›` menu entry, current branch on top, operation-only continue/abort, and the shared action menu.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActionNotice } from '../../../src/client/pages/ActionNotice.tsx'
import { BranchContextMenu } from '../../../src/client/pages/BranchPanel.tsx'
import { BranchAbortConfirm, BranchesPage, filterQuickActions } from '../../../src/client/pages/BranchesPage.tsx'
import type { BranchesPageProps } from '../../../src/client/pages/BranchesPage.tsx'
import { branchActions, quickActions } from '../../../src/client/pages/branch-actions.ts'
import type { BranchActionContext } from '../../../src/client/pages/branch-actions.ts'
import { en, zh } from '../../../src/client/locales.ts'
import { text } from '../../../src/client/localized-text.ts'
import { branchesFixture } from './branch-fixtures.ts'
import { withLocale, zhT, enT } from '../i18n-helpers.tsx'

const EXPANDED = { head: false, local: false, remote: false, tags: false } as const

function context(overrides: Partial<BranchActionContext> = {}): BranchActionContext {
  return { writable: true, operation: null, current: 'main', dirty: false, ...overrides }
}

function page(overrides: Partial<BranchesPageProps> = {}): string {
  const props: BranchesPageProps = {
    value: branchesFixture(),
    context: context(),
    search: '',
    collapsedGroups: EXPANDED,
    collapsedDirs: {},
    flat: false,
    onSearchChange: vi.fn(),
    onToggleGroup: vi.fn(),
    onToggleDirectory: vi.fn(),
    onAction: vi.fn(),
    onQuickAction: vi.fn(),
    onFetch: vi.fn(),
    ...overrides,
  }
  return renderToStaticMarkup(withLocale(<BranchesPage {...props} />))
}

describe('BranchesPage layout', () => {
  it('has the search field, the fetch button and every quick action', () => {
    const html = page()
    expect(html).toContain(zh['branch.page.search'])
    expect(html).toContain('type="search"')
    expect(html).toContain(zh['branch.page.fetch'])
    for (const key of ['branch.quick.update', 'branch.quick.commit', 'branch.quick.push', 'branch.quick.newBranch', 'branch.quick.checkoutRevision'] as const) {
      expect(html).toContain(zh[key])
    }
    expect(html).not.toContain(zh['branch.quick.continue'])
    expect(html).not.toContain(zh['branch.quick.abort'])
  })

  it('groups local / remote / tags with the current branch first and bold', () => {
    const html = page()
    expect(html).toContain('data-group="local"')
    expect(html).toContain('data-group="remote"')
    expect(html).toContain('data-group="tags"')
    expect(html).not.toContain('data-group="head"')
    const localStart = html.indexOf('data-group="local"')
    expect(html.indexOf('data-branch-name="main"', localStart)).toBeLessThan(html.indexOf('data-branch-name="chore"', localStart))
    expect(html).toMatch(/data-branch-name="main"[^>]*data-current="true"/)
    expect(html).toContain('origin/main')
    expect(html).toContain('↑1 ↓2')
  })

  it('every branch row has a › menu button', () => {
    const html = page()
    const rows = html.match(/data-kind="branch"/g)?.length ?? 0
    const buttons = html.match(/data-row-menu/g)?.length ?? 0
    expect(rows).toBeGreaterThan(5)
    expect(buttons).toBe(rows)
    expect(html).toContain(zh['branch.rowMenu'])
  })

  it('shows a detached row in the HEAD group when HEAD is detached', () => {
    const value = { ...branchesFixture(), head: { branch: null, detached: true, sha: 'deadbee11112222333344445555666677778888' } }
    expect(page({ value, context: context({ current: null }) })).toContain('分离 HEAD')
    expect(en['branch.detachedNote']).toBe('detached HEAD')
  })

  it('rows are not text-selectable (double-click checks out; W4)', () => {
    const source = readFileSync(new URL('../../../src/client/pages/BranchesPage.module.css', import.meta.url), 'utf8')
    const row = /\n\.row \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(row).toContain('user-select: none;')
  })

  it('collapsed groups hide their rows', () => {
    const html = page({ collapsedGroups: { head: false, local: false, remote: true, tags: true } })
    expect(html).not.toContain('data-branch-name="origin/main"')
    expect(html).not.toContain('data-branch-name="v1.0.0"')
  })

  it('loading and error states', () => {
    expect(page({ value: null, loading: true })).toContain('aria-busy="true"')
    const failed = page({ value: null, error: { code: 'git/timeout', message: 'slow' } })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain(zh['branch.loadFailed'])
  })
})

describe('BranchesPage search', () => {
  it('matches action names as well as branch names', () => {
    const html = page({ search: '推送' })
    expect(html).toContain(zh['branch.quick.push'])
    expect(html).not.toContain(zh['branch.quick.update'])
    expect(html).not.toContain('data-branch-name=')
  })

  it('a branch-name query keeps matching branches and drops the other rows', () => {
    const html = page({ search: 'login' })
    expect(html).toContain('data-branch-name="feat/login"')
    expect(html).not.toContain('data-branch-name="chore"')
  })

  it('nothing matches → the empty message', () => {
    const html = page({ search: 'zzzz' })
    expect(html).toContain(zh['branch.page.noMatch'])
    expect(html).not.toContain('data-kind="branch"')
  })

  it('filterQuickActions translates before matching, so English queries work in English', () => {
    const items = quickActions(context())
    expect(filterQuickActions(items, 'push', enT).map(item => item.id)).toEqual(['push'])
    expect(filterQuickActions(items, '推送', zhT).map(item => item.id)).toEqual(['push'])
    expect(filterQuickActions(items, '', zhT)).toHaveLength(items.length)
  })
})

describe('BranchesPage operation and read-only state', () => {
  it('continue and abort appear only while an operation is in progress', () => {
    const html = page({ context: context({ operation: 'merge' }) })
    expect(html).toContain(zh['branch.quick.continue'])
    expect(html).toContain(zh['branch.quick.abort'])
    expect(html).toContain('data-danger')
  })

  it('disabled quick actions carry aria-disabled and the reason', () => {
    const html = page({ context: context({ operation: 'merge' }) })
    expect(html).toMatch(/aria-disabled="true"[^>]*title="有操作进行中，先继续或中止它"|title="有操作进行中，先继续或中止它"[^>]*aria-disabled="true"/)
  })

  it('read-only mode shows the notice and disables writes but not the commit page switch', () => {
    const html = page({ context: context({ writable: false }) })
    expect(html).toContain(zh['branch.page.readOnly'])
    expect(html).toMatch(/data-quick="commit"(?![^>]*aria-disabled)/)
    expect(html).toMatch(/data-quick="update"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-quick="update"/)
  })

  it('fetch is busy while a fetch runs', () => {
    const html = page({ fetching: true })
    expect(html).toContain(zh['branch.page.fetching'])
  })
})

describe('BranchContextMenu (shared by the page and the log panel)', () => {
  const login = branchesFixture().local[1]
  if (login === undefined) throw new Error('fixture')

  it('renders every item; disabled ones are aria-disabled with the reason', () => {
    const items = branchActions(login, context({ operation: 'rebase' }))
    const html = renderToStaticMarkup(withLocale(<BranchContextMenu entry={login} items={items} onSelect={() => {}} />))
    expect(html).toContain('role="menu"')
    for (const key of ['branch.action.checkout', 'branch.action.newFrom', 'branch.action.merge', 'branch.action.rename', 'branch.action.delete', 'branch.menu.copyName', 'branch.action.showInLog'] as const) {
      expect(html).toContain(zh[key])
    }
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain(zh['branch.disabled.operation'])
    expect(html).toContain('data-action="copyName"')
  })

  it('draws a separator between sections and marks the delete item as danger', () => {
    const items = branchActions(login, context())
    const html = renderToStaticMarkup(withLocale(<BranchContextMenu entry={login} items={items} onSelect={() => {}} />))
    expect(html.match(/role="separator"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toMatch(/data-action="delete"[^>]*data-danger|data-danger[^>]*data-action="delete"/)
  })

  it('has no write items for a tag beyond checkout and new branch', () => {
    const tag = branchesFixture().tags[0]
    if (tag === undefined) throw new Error('fixture')
    const html = renderToStaticMarkup(withLocale(<BranchContextMenu entry={tag} items={branchActions(tag, context())} onSelect={() => {}} />))
    expect(html).toContain(zh['branch.action.checkoutTag'])
    expect(html).not.toContain(zh['branch.action.delete'])
    expect(html).not.toContain(zh['branch.action.rename'])
    expect(text('branch.action.checkoutTag').key).toBe('branch.action.checkoutTag')
  })
})

describe('ActionNotice', () => {
  it('renders an error as an alert and a warning as a status, with a dismiss button', () => {
    const error = renderToStaticMarkup(withLocale(<ActionNotice notice={{ tone: 'error', message: text('action.error.nothing-to-stash') }} onDismiss={() => {}} />))
    expect(error).toContain('role="alert"')
    expect(error).toContain('没有可以贮藏的改动')
    expect(error).toContain(zh['notice.dismiss'])
    const warning = renderToStaticMarkup(withLocale(<ActionNotice notice={{ tone: 'warning', message: text('notice.stashKept') }} onDismiss={() => {}} />))
    expect(warning).toContain('role="status"')
    expect(renderToStaticMarkup(withLocale(<ActionNotice notice={null} onDismiss={() => {}} />))).toBe('')
  })
})

describe('carry 7: the abort confirmation reuses the banner wording', () => {
  it('says the progress of this operation is discarded but working tree changes are kept', () => {
    const html = renderToStaticMarkup(<BranchAbortConfirm t={zhT} operation="rebase" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(html).toContain('会丢弃本次变基的进度，但保留工作区改动。')
    expect(html).toContain(zh['banner.abort.cancel'])
    expect(html).toContain('中止变基')
    expect(html).toContain('data-abort-confirm')
    const english = renderToStaticMarkup(<BranchAbortConfirm t={enT} operation="merge" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(english).toContain(enT('banner.abort.confirm', { operation: enT('operation.merge') }))
    expect(en).not.toHaveProperty(['branch.quick.abortPrompt'])
  })
})
