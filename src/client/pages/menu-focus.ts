// Row-level focus for row menus (I-1, owner instruction 2026-10-26, JetBrains style): the tree row
// owns focus, its menu takes focus on the first enabled item once placed, and closing the menu
// returns focus to the row. Pure decisions plus thin DOM-optional helpers; React-free.
import { restoreFocus } from '../focus.ts'
import type { FocusTarget } from '../focus.ts'
import { isContextMenuKey } from './commit-actions.ts'

export interface MenuKeyInput {
  key: string
  shiftKey?: boolean
}

export type MenuKeyAction = 'close' | 'next' | 'previous' | 'first' | 'last'

/** What a key does inside an open menu (Enter / Space activate the focused button natively). */
export function menuKeyAction(input: MenuKeyInput): MenuKeyAction | null {
  switch (input.key) {
    case 'Escape':
    case 'ArrowLeft':
    case 'Tab':
      return 'close'
    case 'ArrowDown': return 'next'
    case 'ArrowUp': return 'previous'
    case 'Home': return 'first'
    case 'End': return 'last'
    default: return null
  }
}

/** Index focused when the menu opens: the first enabled item, else the first item; -1 when empty. */
export function firstMenuIndex(disabled: readonly boolean[]): number {
  if (disabled.length === 0) return -1
  const index = disabled.indexOf(false)
  return index === -1 ? 0 : index
}

/**
 * Next item for ArrowDown (`step` 1) / ArrowUp (-1), wrapping. Unavailable (`aria-disabled`) items
 * are visited too, so a screen reader reaches their reason (B4b, WAI-ARIA APG); natively disabled
 * buttons cannot take focus and are not counted. `current` -1 (focus elsewhere) starts from an end.
 */
export function stepMenuIndex(count: number, current: number, step: 1 | -1): number {
  if (count === 0) return -1
  const from = current < 0 ? (step === 1 ? -1 : count) : current
  return (from + step + count) % count
}

/** Focus moves into the menu once it is placed (never into the hidden measuring pass), and only once. */
export function shouldFocusMenu(ready: boolean, focusInside: boolean): boolean {
  return ready && !focusInside
}

export interface TreeRowKeyContext {
  kind: 'branch' | 'directory'
  /** Directory rows: whether the directory is expanded. */
  expanded?: boolean
  /** The row has an action menu (a branch / tag entry). */
  hasMenu: boolean
}

export type TreeRowKeyAction = 'open-menu' | 'expand' | 'collapse' | 'next-row' | 'previous-row'

/**
 * Keys on a focused tree row. Leaf rows open their menu with ArrowRight, Shift+F10 or the
 * ContextMenu key; directory rows keep ArrowRight / ArrowLeft for expand / collapse. Enter keeps
 * its per-tree meaning in the row itself.
 */
export function treeRowKeyAction(row: TreeRowKeyContext, input: MenuKeyInput): TreeRowKeyAction | null {
  if (input.key === 'ArrowDown') return 'next-row'
  if (input.key === 'ArrowUp') return 'previous-row'
  if (row.kind === 'directory') {
    if (input.key === 'ArrowRight') return row.expanded === true ? null : 'expand'
    if (input.key === 'ArrowLeft') return row.expanded === true ? 'collapse' : null
    return null
  }
  if (!row.hasMenu) return null
  if (input.key === 'ArrowRight' || isContextMenuKey({ key: input.key, shiftKey: input.shiftKey === true })) return 'open-menu'
  return null
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Same shape as menu-position's MenuAnchor (kept local: menu-position imports this module). */
export type KeyboardMenuAnchor =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'button'; left: number; right: number; top: number; bottom: number }

/** Where a keyboard-opened row menu hangs: from the `›` button when the row has one, else below the row start. */
export function keyboardMenuAnchor(row: Box, button: Box | null): KeyboardMenuAnchor {
  if (button !== null) return { kind: 'button', left: button.left, right: button.right, top: button.top, bottom: button.bottom }
  return { kind: 'point', x: row.left + 24, y: row.bottom }
}

/**
 * Close a row menu: focus returns to the row first; a chosen action then runs with the row as its
 * trigger, so an overlay it opens takes focus by its own rules and returns it to the row.
 */
export function finishRowMenu(row: FocusTarget | null, choose?: (trigger: FocusTarget | null) => void): void {
  restoreFocus(row)
  choose?.(row)
}

// ---- Thin DOM wrappers (browser only) ----

const MENU_ITEM = '[role="menuitem"]'
const TREE_ITEM = '[role="treeitem"]'

/** The focusable menu items of `root` (natively disabled buttons left out) and whether each is unavailable. */
export function menuItemsOf(root: HTMLElement): { items: HTMLElement[]; disabled: boolean[] } {
  const items = [...root.querySelectorAll<HTMLElement>(MENU_ITEM)].filter(item => !item.matches(':disabled'))
  return { items, disabled: items.map(item => item.getAttribute('aria-disabled') === 'true') }
}

/** The tree row containing `element` (the `›` button's row), or null. */
export function rowOf(element: Element | null): HTMLElement | null {
  const row = element?.closest(TREE_ITEM) ?? null
  return typeof HTMLElement !== 'undefined' && row instanceof HTMLElement ? row : null
}

/** The keyboard menu anchor of a row element (its `[data-row-menu]` button when present). */
export function rowMenuAnchor(row: HTMLElement): KeyboardMenuAnchor {
  const button = row.querySelector('[data-row-menu]')
  return keyboardMenuAnchor(row.getBoundingClientRect(), button === null ? null : button.getBoundingClientRect())
}
