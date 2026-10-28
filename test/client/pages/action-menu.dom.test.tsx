// @vitest-environment happy-dom
// B4b T5: menu keyboard. Unavailable items stay focusable (aria-disabled, WAI-ARIA APG) and their
// reason is the item's description; arrow keys wrap over every item; Home/End go to the ends.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionMenu } from '../../../src/client/pages/ActionMenu.tsx'
import type { ActionMenuItem } from '../../../src/client/pages/ActionMenu.tsx'
import { MergeFooter } from '../../../src/client/pages/MergeWindowParts.tsx'
import { RepoBar } from '../../../src/client/pages/RepoBar.tsx'
import { accessibleName, byRole, click, pointerDown, press, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale, zhT } from '../i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

const items: ActionMenuItem<'a' | 'b' | 'c'>[] = [
  { id: 'a', label: { key: 'action.refresh' }, section: 0 },
  { id: 'b', label: { key: 'action.retry' }, disabledReason: { key: 'branch.disabled.readOnly' }, section: 0 },
  { id: 'c', label: { key: 'action.close' }, section: 1 },
]

function activeAction(): string | undefined {
  return (document.activeElement as HTMLElement | null)?.dataset.action
}

function description(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
}

describe('ActionMenu keyboard (DOM)', () => {
  it('focuses the first enabled item, then ↓ ↑ Home End visit every item including unavailable ones', () => {
    view = render(withLocale(<ActionMenu label="m" items={items} onSelect={() => {}} onClose={() => {}} />) as ReactElement)
    expect(activeAction()).toBe('a')
    press('ArrowDown')
    expect(activeAction()).toBe('b')
    press('ArrowDown')
    expect(activeAction()).toBe('c')
    press('ArrowDown')
    expect(activeAction()).toBe('a')
    press('ArrowUp')
    expect(activeAction()).toBe('c')
    press('Home')
    expect(activeAction()).toBe('a')
    press('End')
    expect(activeAction()).toBe('c')
  })

  it('an unavailable item is named by its label, described by its reason, and does nothing when activated', () => {
    const onSelect = vi.fn()
    view = render(withLocale(<ActionMenu label="m" items={items} onSelect={onSelect} onClose={() => {}} />) as ReactElement)
    const b = view.container.querySelector('[data-action="b"]') as HTMLElement
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(accessibleName(b)).toBe(zhT('action.retry'))
    expect(description(b)).toBe(zhT('branch.disabled.readOnly'))
    click(b)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Esc closes', () => {
    const onClose = vi.fn()
    view = render(withLocale(<ActionMenu label="m" items={items} onSelect={() => {}} onClose={onClose} />) as ReactElement)
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('repo bar ⋯ menu keyboard (DOM)', () => {
  it('opening moves focus to the first item; ↓ moves; Tab closes and refocuses ⋯', () => {
    view = render(withLocale(<RepoBar repoRoot="/tmp/repo" onRefresh={() => {}} onOpenConsole={() => {}} onSettings={() => {}} />) as ReactElement)
    const more = byRole(view.container, 'button', zhT('repo.more'))
    click(more)
    expect(accessibleName(document.activeElement as Element)).toBe(zhT('action.refresh'))
    press('ArrowDown')
    expect(accessibleName(document.activeElement as Element)).toBe(zhT('console.title'))
    press('Tab')
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)
  })
})

function Footer(): ReactElement {
  const [open, setOpen] = useState(true)
  const label = { label: 'main', name: 'main', technical: 'ours' }
  return (
    <MergeFooter
      t={zhT}
      sides={{ left: label, right: { ...label, label: 'feat' }, note: null }}
      busy={false}
      applied={false}
      blockReason={null}
      nonConflictingOpen={open}
      onAction={() => {}}
      onToggleNonConflicting={() => setOpen(value => !value)}
      onApply={() => {}}
    />
  )
}

describe('merge window "apply non-conflicting ▾" menu (DOM)', () => {
  it('Esc closes it and returns focus to the ▾ toggle', () => {
    view = render(withLocale(<Footer />) as ReactElement)
    press('Escape')
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(view.container.querySelector('[data-merge-non-conflicting]'))
  })

  it('takes focus, moves with ↓, and closes on an outside click', () => {
    view = render(withLocale(<Footer />) as ReactElement)
    expect((document.activeElement as HTMLElement).dataset.nonConflicting).toBe('left')
    press('ArrowDown')
    expect((document.activeElement as HTMLElement).dataset.nonConflicting).toBe('all')
    // A pointer-down on the ▾ toggle is inside the menu's boundary: the toggle's own click decides.
    pointerDown(view.container.querySelector('[data-merge-non-conflicting]') as HTMLElement)
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull()
    pointerDown(document.body)
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
  })
})
