// Tab containment for modal dialogs (B4b T6, `aria-modal="true"`): Tab on the last focusable
// control wraps to the first and Shift+Tab on the first wraps to the last. Between the ends the
// browser moves focus natively. Non-modal overlays (Blame, history) do not trap.
import type { KeyboardEvent } from 'react'

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'

/** Focusable controls of `root` in DOM order (disabled, hidden and tabIndex<0 left out). */
export function tabbablesOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element =>
    element.tabIndex >= 0 && !element.matches(':disabled') && element.closest('[hidden], [inert]') === null)
}

/** Wrap Tab inside `root`; returns true when it moved focus. */
export function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement): boolean {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false
  const items = tabbablesOf(root)
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return false
  }
  const active = root.ownerDocument.activeElement
  const outside = !(active instanceof HTMLElement) || !items.includes(active)
  if (event.shiftKey && (active === first || active === root || outside)) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
