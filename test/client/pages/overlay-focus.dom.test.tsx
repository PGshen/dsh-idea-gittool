// @vitest-environment happy-dom
// B4b T6: overlay focus — focus moves in on open, Esc goes back one level, closing returns focus to
// the trigger, and modal dialogs keep Tab inside.
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirtyWorktreeSheet } from '../../../src/client/pages/DirtyWorktreeSheet.tsx'
import { SettingsSheet } from '../../../src/client/pages/SettingsSheet.tsx'
import { useWorkbenchOverlay } from '../../../src/client/pages/workbench-overlay.ts'
import type { StashAsk } from '../../../src/client/store/action-store.ts'
import { byRole, click, press, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null; localStorage.clear() })

function tabbables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled'))
}

function expectTabTrapped(dialog: HTMLElement): void {
  const items = tabbables(dialog)
  expect(items.length).toBeGreaterThan(1)
  const first = items[0] as HTMLElement
  const last = items[items.length - 1] as HTMLElement
  last.focus()
  press('Tab')
  expect(document.activeElement).toBe(first)
  press('Tab', first, { shiftKey: true })
  expect(document.activeElement).toBe(last)
}

describe('settings sheet (DOM)', () => {
  it('takes focus on open, closes on Esc and keeps Tab inside', () => {
    const onClose = vi.fn()
    view = render(withLocale(<SettingsSheet onClose={onClose} />) as ReactElement)
    const dialog = byRole(view.container, 'dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expectTabTrapped(dialog)
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('dirty worktree question (DOM)', () => {
  const ask: StashAsk = { key: 'k', endpoint: 'checkout', operation: 'checkout', paths: ['a.txt', 'b.txt'], count: 2, trigger: null }
  it('takes focus on open, cancels on Esc and keeps Tab inside', () => {
    const onCancel = vi.fn()
    view = render(withLocale(<DirtyWorktreeSheet ask={ask} onStash={() => {}} onCancel={onCancel} />) as ReactElement)
    const dialog = byRole(view.container, 'dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expectTabTrapped(dialog)
    press('Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

function Workbench(): ReactElement {
  const overlays = useWorkbenchOverlay()
  return (
    <div>
      <button type="button" data-open-settings onClick={(event) => { overlays.open({ kind: 'settings' }, event.currentTarget) }}>open</button>
      {overlays.overlay?.kind === 'settings'
        ? (
            <div role="dialog" aria-label="overlay">
              <button type="button" data-open-remotes onClick={(event) => { overlays.open({ kind: 'remotes' }, event.currentTarget) }}>remotes</button>
              <button type="button" data-close onClick={overlays.close}>close</button>
            </div>
          )
        : null}
      {overlays.overlay?.kind === 'remotes'
        ? <div role="dialog" aria-label="nested"><button type="button" data-back onClick={overlays.close}>back</button></div>
        : null}
    </div>
  )
}

describe('workbench overlay focus return (DOM)', () => {
  // Opening an overlay from another one replaces it (overlays with `back` return to their parent and
  // take focus by their own rules); the page trigger is kept for the final close.
  it('closing returns focus to the page trigger, also after one overlay replaced another', () => {
    view = render(withLocale(<Workbench />) as ReactElement)
    const open = view.container.querySelector<HTMLElement>('[data-open-settings]') as HTMLElement
    open.focus()
    click(open)
    click(view.container.querySelector('[data-close]') as HTMLElement)
    expect(document.activeElement).toBe(open)
    click(open)
    const nestedTrigger = view.container.querySelector<HTMLElement>('[data-open-remotes]') as HTMLElement
    nestedTrigger.focus()
    click(nestedTrigger)
    click(view.container.querySelector('[data-back]') as HTMLElement)
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(open)
  })
})

