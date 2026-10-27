// Keyboard model of the B2 lists (file history, compare files, blame lines; final review I4): the list is
// one tab stop, arrows / Home / End move the active row, Enter activates it, ContextMenu or Shift+F10
// opens the row menu — the same keys as the log and the change tree. React-free.

export type ListKeyAction = 'next' | 'previous' | 'first' | 'last' | 'activate' | 'menu'

export function listKeyAction(event: { key: string; shiftKey: boolean }): ListKeyAction | null {
  switch (event.key) {
    case 'ArrowDown': return 'next'
    case 'ArrowUp': return 'previous'
    case 'Home': return 'first'
    case 'End': return 'last'
    case 'Enter': return 'activate'
    case 'ContextMenu': return 'menu'
    case 'F10': return event.shiftKey ? 'menu' : null
    default: return null
  }
}

/** The row an arrow / Home / End lands on; from no active row, down starts at the top and up at the bottom. */
export function stepListIndex(length: number, current: number, action: 'next' | 'previous' | 'first' | 'last'): number {
  if (length === 0) return -1
  if (action === 'first') return 0
  if (action === 'last') return length - 1
  if (current === -1) return action === 'next' ? 0 : length - 1
  return Math.max(0, Math.min(length - 1, current + (action === 'next' ? 1 : -1)))
}

/** Menu anchor under a row found by id (keyboard-opened menus have no pointer). */
export function rowAnchor(id: string): { kind: 'point'; x: number; y: number } {
  const rect = globalThis.document?.getElementById(id)?.getBoundingClientRect()
  return rect === undefined ? { kind: 'point', x: 0, y: 0 } : { kind: 'point', x: rect.left + 16, y: rect.bottom }
}
