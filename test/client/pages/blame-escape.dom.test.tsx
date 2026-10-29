// @vitest-environment happy-dom
// B2 final review minor: the `git.blame` page has no level to go back to, so Esc must reach the host.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../src/client/i18n.tsx'
import { BlameView } from '../../../src/client/pages/BlameView.tsx'
import type { BlameViewProps } from '../../../src/client/pages/BlameView.tsx'
import type { BlameState } from '../../../src/client/store/blame-store.ts'
import { render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { zhT } from '../i18n-helpers.tsx'

const state: BlameState = {
  target: { path: 'src/f.ts' }, status: 'loading', value: null, rows: [], commits: {},
  loadingMore: false, error: null, selectedSha: null,
}

const noop = (): void => undefined

function props(extra: Partial<BlameViewProps> = {}): BlameViewProps {
  return {
    state, branch: 'main', compact: false, hovered: null, menu: null, diff: null, now: 0,
    onToggleCompact: noop, onLoadMore: noop, onRetry: noop, onSelect: noop, onOpenDiff: noop,
    onHover: noop, onMenu: noop, onCloseMenu: noop, onMenuAction: noop, onCloseDiff: noop, onCopyHash: noop,
    onShowInLog: noop, onFileHistory: noop,
    ...extra,
  }
}

/** Press Esc on the Blame view; returns whether it reached the document and whether it was cancelled. */
function pressEscape(view: Rendered): { reached: boolean; prevented: boolean } {
  let reached = false
  const listener = (): void => { reached = true }
  document.addEventListener('keydown', listener)
  const target = view.container.querySelector('[data-blame-view]')
  if (target === null) throw new Error('no blame view')
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  document.removeEventListener('keydown', listener)
  return { reached, prevented: event.defaultPrevented }
}

let view: Rendered | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

describe('BlameView Esc', () => {
  it('lets Esc through when there is no back target (the git.blame page)', () => {
    view = render(<I18nProvider t={zhT}><BlameView {...props()} /></I18nProvider>)
    expect(pressEscape(view)).toEqual({ reached: true, prevented: false })
  })

  it('still takes Esc to go back, or to close the in-place diff first', () => {
    const onBack = vi.fn()
    view = render(<I18nProvider t={zhT}><BlameView {...props({ onBack })} /></I18nProvider>)
    expect(pressEscape(view).prevented).toBe(true)
    expect(onBack).toHaveBeenCalledTimes(1)
    view.unmount()
    const onCloseDiff = vi.fn()
    view = render(<I18nProvider t={zhT}><BlameView {...props({ diff: { request: null, status: 'loading', value: null, error: null }, onCloseDiff })} /></I18nProvider>)
    expect(pressEscape(view).prevented).toBe(true)
    expect(onCloseDiff).toHaveBeenCalledTimes(1)
  })
})
