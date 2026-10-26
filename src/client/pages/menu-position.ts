// Floating menu placement (final review W1): the menu is measured after it renders and kept
// inside the viewport and the Git panel. A right-click menu opens at the pointer; a `›` menu
// hangs from the button's right edge. Both flip above when there is no room below.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, RefObject } from 'react'
import { firstMenuIndex, lastMenuIndex, menuItemsOf, menuKeyAction, shouldFocusMenu, stepMenuIndex } from './menu-focus.ts'

export type MenuAnchor =
  /** Right click / keyboard menu: the pointer (or row) position in viewport coordinates. */
  | { kind: 'point'; x: number; y: number }
  /** A menu button: its viewport rectangle. */
  | { kind: 'button'; left: number; right: number; top: number; bottom: number }

export interface MenuRect {
  left: number
  top: number
  right: number
  bottom: number
}

const MARGIN = 8

/** Where the menu may go: the viewport, narrowed to the Git panel when it is known. */
export function menuBounds(viewport: { width: number; height: number }, panel: MenuRect | null): MenuRect {
  const view = { left: 0, top: 0, right: viewport.width, bottom: viewport.height }
  if (panel === null) return view
  return {
    left: Math.max(view.left, panel.left),
    top: Math.max(view.top, panel.top),
    right: Math.min(view.right, panel.right),
    bottom: Math.min(view.bottom, panel.bottom),
  }
}

/** Top-left corner of a menu of `size` for `anchor` inside `bounds`. */
export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, bounds: MenuRect): { x: number; y: number } {
  const x = anchor.kind === 'point' ? anchor.x : anchor.right - size.width
  const below = anchor.kind === 'point' ? anchor.y : anchor.bottom
  const above = (anchor.kind === 'point' ? anchor.y : anchor.top) - size.height
  const fitsBelow = below + size.height <= bounds.bottom - MARGIN
  const fitsAbove = above >= bounds.top + MARGIN
  const y = !fitsBelow && fitsAbove ? above : below
  // When the menu is larger than the bounds, the start margin wins (its first items stay visible).
  const clamp = (value: number, extent: number, start: number, end: number): number =>
    Math.max(start + MARGIN, Math.min(value, end - extent - MARGIN))
  return { x: clamp(x, size.width, bounds.left, bounds.right), y: clamp(y, size.height, bounds.top, bounds.bottom) }
}

/**
 * The measuring render: at the viewport origin (a fixed menu opened near the right edge would
 * otherwise shrink to the remaining width and measure too narrow) and invisible; the layout
 * effect moves it before the browser paints. Focus waits for the placed render (`ready`).
 */
const MEASURING: CSSProperties = { left: '0px', top: '0px', visibility: 'hidden' }

// No layout effects during static rendering (tests); the browser measures before paint.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** The Git panel root the menus must stay in (`data-dsh-git-workbench`). */
const PANEL_SELECTOR = '[data-dsh-git-workbench]'

export interface MenuPlacement {
  /** Inline style; undefined when there is no anchor (the menu renders in the document flow). */
  style: CSSProperties | undefined
  /** Placed and visible: only now may the menu take focus (a hidden element cannot, I-1). */
  ready: boolean
}

/** Placement state for the anchor (`anchorKey`, null without one) and the last measured placement. */
export function menuPlacement(anchorKey: string | null, placed: { key: string; x: number; y: number } | null): MenuPlacement {
  if (anchorKey === null) return { style: undefined, ready: true }
  if (placed === null || placed.key !== anchorKey) return { style: MEASURING, ready: false }
  return { style: { left: `${placed.x}px`, top: `${placed.y}px` }, ready: true }
}

/**
 * Placement of a floating menu: rendered hidden at the origin, then measured and moved inside the
 * viewport and the Git panel before the browser paints.
 */
export function useMenuPlacement(ref: RefObject<HTMLElement>, anchor: MenuAnchor | undefined): MenuPlacement {
  const [placed, setPlaced] = useState<{ key: string; x: number; y: number } | null>(null)
  // The anchor is compared by value: a re-render with an equal anchor does not re-measure.
  const key = anchor === undefined ? '' : JSON.stringify(anchor)
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  useBrowserLayoutEffect(() => {
    const element = ref.current
    const current = anchorRef.current
    if (current === undefined || element === null) return
    const box = element.getBoundingClientRect()
    const panel = element.closest(PANEL_SELECTOR)?.getBoundingClientRect() ?? null
    const bounds = menuBounds({ width: window.innerWidth, height: window.innerHeight }, panel)
    setPlaced({ key, ...placeMenu(current, { width: box.width, height: box.height }, bounds) })
  }, [key, ref])
  return menuPlacement(anchor === undefined ? null : key, placed)
}

/**
 * A floating row menu (branch / commit): placement, focus on the first enabled item once placed,
 * arrow keys between items (wrapping), Esc / ArrowLeft / Tab and outside pointer-downs close it.
 * `onClose` may change on every parent render; the listener and focus do not re-run for it.
 */
export function useFloatingMenu(
  ref: RefObject<HTMLElement>,
  anchor: MenuAnchor | undefined,
  onClose: (() => void) | undefined,
): { style: CSSProperties | undefined; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const closable = onClose !== undefined
  const { style, ready } = useMenuPlacement(ref, anchor)
  useEffect(() => {
    if (!closable) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return
      closeRef.current?.()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [closable, ref])
  useEffect(() => {
    const root = ref.current
    if (root === null || !shouldFocusMenu(ready, root.contains(document.activeElement))) return
    const { items, disabled } = menuItemsOf(root)
    items[firstMenuIndex(disabled)]?.focus()
  }, [ready, ref])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const action = menuKeyAction(event)
    if (action === null) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'close') {
      closeRef.current?.()
      return
    }
    const root = ref.current
    if (root === null) return
    const { items, disabled } = menuItemsOf(root)
    const current = items.findIndex(item => item === document.activeElement)
    const index = action === 'first'
      ? firstMenuIndex(disabled)
      : action === 'last' ? lastMenuIndex(disabled) : stepMenuIndex(disabled, current, action === 'next' ? 1 : -1)
    items[index]?.focus()
  }
  return { style, onKeyDown }
}
