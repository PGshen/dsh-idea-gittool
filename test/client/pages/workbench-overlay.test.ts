// A3 T6 overlay routing (design §5.3): one overlay at a time, opening replaces, Esc goes back one
// level, closing returns focus to the control that opened the first overlay.
import { describe, expect, it, vi } from 'vitest'
import {
  CLOSED_ROUTE,
  OVERLAY_LEVEL,
  closeOverlay,
  handleOverlayEscape,
  openOverlay,
} from '../../../src/client/pages/workbench-overlay.ts'
import type { FocusTarget, WorkbenchOverlay } from '../../../src/client/pages/workbench-overlay.ts'

function target(connected = true): FocusTarget {
  return { focus: vi.fn<() => void>(), isConnected: connected }
}

const PUSH: WorkbenchOverlay = { kind: 'push' }
const ROLLBACK: WorkbenchOverlay = { kind: 'rollback', targets: [{ path: 'a.ts', untracked: false }] }

describe('openOverlay', () => {
  it('opens on a closed route and records the trigger', () => {
    const trigger = target()
    const result = openOverlay(CLOSED_ROUTE, PUSH, trigger)
    expect(result.route).toEqual({ overlay: PUSH, returnFocus: trigger })
    expect(result.left).toBeNull()
  })

  it('replaces the current overlay and keeps the original trigger (the replaced overlay is gone)', () => {
    const pageButton = target()
    const insideOverlay = target()
    const first = openOverlay(CLOSED_ROUTE, PUSH, pageButton).route
    const result = openOverlay(first, ROLLBACK, insideOverlay)
    expect(result.route).toEqual({ overlay: ROLLBACK, returnFocus: pageButton })
    expect(result.left).toBe(PUSH)
  })

  it('a missing trigger on a closed route records nothing', () => {
    expect(openOverlay(CLOSED_ROUTE, PUSH, null).route.returnFocus).toBeNull()
  })
})

describe('closeOverlay', () => {
  it('closes and hands back the trigger to focus', () => {
    const trigger = target()
    const open = openOverlay(CLOSED_ROUTE, PUSH, trigger).route
    const result = closeOverlay(open)
    expect(result.route).toEqual(CLOSED_ROUTE)
    expect(result.left).toBe(PUSH)
    expect(result.focus).toBe(trigger)
  })

  it('does not hand back a detached trigger', () => {
    const open = openOverlay(CLOSED_ROUTE, PUSH, target(false)).route
    expect(closeOverlay(open).focus).toBeNull()
  })

  it('closing a closed route is a no-op', () => {
    expect(closeOverlay(CLOSED_ROUTE)).toEqual({ route: CLOSED_ROUTE, left: null, focus: null })
  })
})

describe('handleOverlayEscape', () => {
  function key(name: string, defaultPrevented = false) {
    return { key: name, defaultPrevented, preventDefault: vi.fn() }
  }

  it('Esc with an overlay open closes it once (one level)', () => {
    const close = vi.fn()
    const event = key('Escape')
    expect(handleOverlayEscape(event, { overlay: PUSH, returnFocus: null }, close)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('leaves Esc alone when the overlay already handled it, when nothing is open, or for other keys', () => {
    const close = vi.fn()
    expect(handleOverlayEscape(key('Escape', true), { overlay: PUSH, returnFocus: null }, close)).toBe(false)
    expect(handleOverlayEscape(key('Escape'), CLOSED_ROUTE, close)).toBe(false)
    expect(handleOverlayEscape(key('Enter'), { overlay: PUSH, returnFocus: null }, close)).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('WorkbenchOverlay kinds', () => {
  it('every kind has a navigation level (1 = overlay page, 2 = sheet)', () => {
    expect(Object.keys(OVERLAY_LEVEL).sort()).toEqual([
      'branchSheet', 'conflicts', 'diff', 'dirtyWorktree', 'merge', 'pull', 'push', 'pushRejected', 'rebase',
      'reset', 'rollback', 'smartCheckout', 'stashCreate', 'updateProject',
    ])
    expect(OVERLAY_LEVEL.diff).toBe(1)
    expect(OVERLAY_LEVEL.rollback).toBe(2)
    expect(OVERLAY_LEVEL.dirtyWorktree).toBe(2)
  })
})
