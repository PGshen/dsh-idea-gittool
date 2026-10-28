// @vitest-environment happy-dom
// B4b acceptance walkthrough: the stash page must be usable from the keyboard alone.
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StashPageView } from '../../../src/client/pages/StashPage.tsx'
import type { StashPageViewProps } from '../../../src/client/pages/StashPage.tsx'
import type { StashStoreState } from '../../../src/client/store/stash-store.ts'
import type { StashEntry } from '../../../src/shared/protocol.ts'
import { focus, press, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'

const SHA = 'a'.repeat(40)
const noop = (): void => {}
const ENTRY: StashEntry = { sha: SHA, index: 0, message: 'walk stash', branch: 'main', date: '2026-10-26T07:00:00.000Z', fileCount: 1 }

function state(selectedSha: string | null): StashStoreState {
  return {
    list: { status: 'ready', entries: [ENTRY], version: 1, error: null },
    selectedSha,
    files: { status: 'idle', sha: null, value: null, error: null },
  } as StashStoreState
}

function ui(props: Partial<StashPageViewProps>): ReactElement {
  return withLocale(
    <StashPageView
      state={state(null)} now={Date.parse('2026-10-26T12:00:00.000Z')} busy={false} confirmingSha={null}
      onSelect={noop} onPreview={noop} onCreate={noop} onApply={noop} onAskDrop={noop}
      onCancelDrop={noop} onConfirmDrop={noop} onOpenFile={noop} onRetry={noop}
      {...props}
    />,
  ) as ReactElement
}

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

/** What a browser does when the focused button becomes disabled: focus falls back to <body>. */
function dropFocus(): void {
  const probe = document.createElement('button')
  document.body.appendChild(probe)
  probe.focus()
  probe.remove()
}

const row = (): HTMLElement => document.querySelector(`[data-sha="${SHA}"]`) as HTMLElement
const applyButton = (): HTMLButtonElement => [...document.querySelectorAll('button')].find(b => b.textContent === '应用') as HTMLButtonElement

describe('stash list keyboard (DOM)', () => {
  it('focusing a row selects it (single-select listbox), so a lone stash is selectable from the keyboard', () => {
    const onSelect = vi.fn()
    view = render(ui({ onSelect }))
    focus(row())
    expect(onSelect).toHaveBeenCalledWith(SHA)
  })

  it('Space selects the focused row', () => {
    const onSelect = vi.fn()
    view = render(ui({ state: state(SHA), onSelect }))
    focus(row())
    press(' ')
    expect(onSelect).toHaveBeenCalledWith(SHA)
  })

  it('focusing the already selected row does not reselect it (no extra file reload)', () => {
    const onSelect = vi.fn()
    view = render(ui({ state: state(SHA), onSelect }))
    focus(row())
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('stash write focus (DOM)', () => {
  it('when a write disables the focused Apply button, focus comes back to it once the write ends', () => {
    view = render(ui({ state: state(SHA) }))
    focus(applyButton())
    view.rerender(ui({ state: state(SHA), busy: true }))
    dropFocus()
    expect(document.activeElement).toBe(document.body)
    view.rerender(ui({ state: state(SHA), busy: false }))
    expect(document.activeElement).toBe(applyButton())
  })

  it('falls back to the selected row when the button stays unavailable (pop removed the selection)', () => {
    view = render(ui({ state: state(SHA) }))
    focus(applyButton())
    view.rerender(ui({ state: state(SHA), busy: true }))
    dropFocus()
    view.rerender(ui({ state: { ...state(null) }, busy: false }))
    expect(document.activeElement).toBe(row())
  })
})
