// I-1 (owner instruction 2026-10-26): row-level focus like JetBrains. The row owns focus, the menu
// takes focus on its first enabled item once placed, and closing it returns focus to the row.
import { describe, expect, it } from 'vitest'
import type { FocusTarget } from '../../../src/client/focus.ts'
import {
  finishRowMenu,
  firstMenuIndex,
  keyboardMenuAnchor,
  lastMenuIndex,
  menuKeyAction,
  shouldFocusMenu,
  stepMenuIndex,
  treeRowKeyAction,
  treeStepIndex,
} from '../../../src/client/pages/menu-focus.ts'

function target(log: string[], name: string, isConnected = true): FocusTarget {
  return { isConnected, focus: () => { log.push(`focus:${name}`) } }
}

describe('menuKeyAction', () => {
  it('Esc and ArrowLeft close back to the row; Tab closes too', () => {
    expect(menuKeyAction({ key: 'Escape' })).toBe('close')
    expect(menuKeyAction({ key: 'ArrowLeft' })).toBe('close')
    expect(menuKeyAction({ key: 'Tab' })).toBe('close')
  })
  it('ArrowUp / ArrowDown / Home / End move between items', () => {
    expect(menuKeyAction({ key: 'ArrowDown' })).toBe('next')
    expect(menuKeyAction({ key: 'ArrowUp' })).toBe('previous')
    expect(menuKeyAction({ key: 'Home' })).toBe('first')
    expect(menuKeyAction({ key: 'End' })).toBe('last')
  })
  it('other keys (Enter activates the focused button natively) are not handled', () => {
    expect(menuKeyAction({ key: 'Enter' })).toBeNull()
    expect(menuKeyAction({ key: 'ArrowRight' })).toBeNull()
    expect(menuKeyAction({ key: 'a' })).toBeNull()
  })
})

describe('menu item focus order', () => {
  it('opening focuses the first enabled item', () => {
    expect(firstMenuIndex([true, true, false, false])).toBe(2)
    expect(firstMenuIndex([false, true])).toBe(0)
  })
  it('all disabled: the first item still takes focus (the menu stays operable); empty: none', () => {
    expect(firstMenuIndex([true, true])).toBe(0)
    expect(firstMenuIndex([])).toBe(-1)
  })
  it('last enabled item for End', () => {
    expect(lastMenuIndex([false, false, true])).toBe(1)
    expect(lastMenuIndex([true])).toBe(0)
    expect(lastMenuIndex([])).toBe(-1)
  })
  it('ArrowDown / ArrowUp skip disabled items and wrap', () => {
    const disabled = [false, true, false, false]
    expect(stepMenuIndex(disabled, 0, 1)).toBe(2)
    expect(stepMenuIndex(disabled, 3, 1)).toBe(0)
    expect(stepMenuIndex(disabled, 0, -1)).toBe(3)
    expect(stepMenuIndex(disabled, 2, -1)).toBe(0)
  })
  it('focus outside the items (current -1) starts from the ends', () => {
    expect(stepMenuIndex([false, false], -1, 1)).toBe(0)
    expect(stepMenuIndex([false, false], -1, -1)).toBe(1)
  })
  it('all disabled: moves over every item; empty: none', () => {
    expect(stepMenuIndex([true, true, true], 2, 1)).toBe(0)
    expect(stepMenuIndex([], 0, 1)).toBe(-1)
  })
  it('focus moves into the menu only once it is placed and focus is not already inside', () => {
    expect(shouldFocusMenu(false, false)).toBe(false)
    expect(shouldFocusMenu(true, false)).toBe(true)
    expect(shouldFocusMenu(true, true)).toBe(false)
  })
})

describe('treeRowKeyAction', () => {
  const leaf = { kind: 'branch' as const, hasMenu: true }
  it('a leaf branch row opens its menu with ArrowRight, Shift+F10 and the ContextMenu key', () => {
    expect(treeRowKeyAction(leaf, { key: 'ArrowRight' })).toBe('open-menu')
    expect(treeRowKeyAction(leaf, { key: 'F10', shiftKey: true })).toBe('open-menu')
    expect(treeRowKeyAction(leaf, { key: 'ContextMenu' })).toBe('open-menu')
    expect(treeRowKeyAction(leaf, { key: 'F10' })).toBeNull()
  })
  it('a row without an entry has no menu', () => {
    expect(treeRowKeyAction({ kind: 'branch', hasMenu: false }, { key: 'ArrowRight' })).toBeNull()
    expect(treeRowKeyAction({ kind: 'branch', hasMenu: false }, { key: 'ContextMenu' })).toBeNull()
  })
  it('directory rows keep ArrowRight / ArrowLeft for expand / collapse and never open a menu', () => {
    expect(treeRowKeyAction({ kind: 'directory', expanded: false, hasMenu: false }, { key: 'ArrowRight' })).toBe('expand')
    expect(treeRowKeyAction({ kind: 'directory', expanded: true, hasMenu: false }, { key: 'ArrowRight' })).toBeNull()
    expect(treeRowKeyAction({ kind: 'directory', expanded: true, hasMenu: false }, { key: 'ArrowLeft' })).toBe('collapse')
    expect(treeRowKeyAction({ kind: 'directory', expanded: false, hasMenu: false }, { key: 'ArrowLeft' })).toBeNull()
    expect(treeRowKeyAction({ kind: 'directory', expanded: false, hasMenu: false }, { key: 'ContextMenu' })).toBeNull()
  })
  it('ArrowUp / ArrowDown move between rows; ArrowLeft on a leaf does nothing', () => {
    expect(treeRowKeyAction(leaf, { key: 'ArrowDown' })).toBe('next-row')
    expect(treeRowKeyAction(leaf, { key: 'ArrowUp' })).toBe('previous-row')
    expect(treeRowKeyAction({ kind: 'directory', expanded: true, hasMenu: false }, { key: 'ArrowDown' })).toBe('next-row')
    expect(treeRowKeyAction(leaf, { key: 'ArrowLeft' })).toBeNull()
  })
  it('Enter keeps its existing per-tree meaning (handled by the row, not here)', () => {
    expect(treeRowKeyAction(leaf, { key: 'Enter' })).toBeNull()
  })
})

describe('treeStepIndex', () => {
  it('moves one row and stops at the ends (no wrap)', () => {
    expect(treeStepIndex(3, 0, 1)).toBe(1)
    expect(treeStepIndex(3, 2, 1)).toBe(2)
    expect(treeStepIndex(3, 0, -1)).toBe(0)
    expect(treeStepIndex(0, 0, 1)).toBe(-1)
  })
})

describe('keyboardMenuAnchor', () => {
  const row = { left: 10, right: 300, top: 40, bottom: 60 }
  it('hangs from the › button when the row has one (same as clicking it)', () => {
    const button = { left: 280, right: 296, top: 42, bottom: 58 }
    expect(keyboardMenuAnchor(row, button)).toEqual({ kind: 'button', ...button })
  })
  it('without a › button: below the row start (like the log keyboard menu)', () => {
    expect(keyboardMenuAnchor(row, null)).toEqual({ kind: 'point', x: 34, y: 60 })
  })
})

describe('finishRowMenu', () => {
  it('focus returns to the row before the chosen action runs, which gets the row as its trigger', () => {
    const log: string[] = []
    const row = target(log, 'row')
    finishRowMenu(row, (trigger) => { log.push(trigger === row ? 'action:row' : 'action:other') })
    expect(log).toEqual(['focus:row', 'action:row'])
  })
  it('dismissing (no action) only refocuses the row', () => {
    const log: string[] = []
    finishRowMenu(target(log, 'row'))
    expect(log).toEqual(['focus:row'])
  })
  it('a detached row is skipped; the action still runs', () => {
    const log: string[] = []
    finishRowMenu(target(log, 'row', false), () => { log.push('action') })
    expect(log).toEqual(['action'])
  })
})
