// Focus return for overlays (design §5.3: closing an overlay returns focus to its trigger).
// React-free and DOM-optional: a FocusTarget is anything element-like, so stores and pure
// routing code can carry the trigger captured at click time.

/** What focus returns to (an HTMLElement in the browser). */
export interface FocusTarget {
  focus(): void
  readonly isConnected: boolean
}

/** The focused element, as a focus target (null outside the browser or when nothing is focused). */
export function activeFocusTarget(): FocusTarget | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  return typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active !== document.body ? active : null
}

/**
 * Focus `target` if it is still attached. Never throws (a detached or failing element is skipped).
 * @returns true when focus was moved.
 */
export function restoreFocus(target: FocusTarget | null): boolean {
  if (target === null || !target.isConnected) return false
  try {
    target.focus()
    return true
  } catch {
    return false
  }
}
