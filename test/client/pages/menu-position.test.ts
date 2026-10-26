// W1 (final review): floating menus are measured after render and kept inside the viewport and
// the Git panel; `›` menus hang from the button's right edge and flip above when there is no room.
import { describe, expect, it } from 'vitest'
import { menuBounds, menuPlacement, placeMenu } from '../../../src/client/pages/menu-position.ts'

const VIEW = { left: 0, top: 0, right: 800, bottom: 600 }
const SIZE = { width: 200, height: 300 }

describe('placeMenu / point anchor (right-click)', () => {
  it('opens at the pointer when it fits', () => {
    expect(placeMenu({ kind: 'point', x: 50, y: 60 }, SIZE, VIEW)).toEqual({ x: 50, y: 60 })
  })
  it('right overflow: shifted left to stay inside', () => {
    expect(placeMenu({ kind: 'point', x: 750, y: 60 }, SIZE, VIEW)).toEqual({ x: 592, y: 60 })
  })
  it('left / top overflow: kept at the margin', () => {
    expect(placeMenu({ kind: 'point', x: -20, y: -5 }, SIZE, VIEW)).toEqual({ x: 8, y: 8 })
  })
  it('bottom overflow: flips above the pointer', () => {
    expect(placeMenu({ kind: 'point', x: 50, y: 500 }, SIZE, VIEW)).toEqual({ x: 50, y: 200 })
  })
  it('no room above either: clamped to the bottom edge', () => {
    expect(placeMenu({ kind: 'point', x: 50, y: 250 }, { width: 200, height: 500 }, VIEW)).toEqual({ x: 50, y: 92 })
  })
  it('taller than the bounds: pinned to the top margin', () => {
    expect(placeMenu({ kind: 'point', x: 50, y: 250 }, { width: 200, height: 900 }, VIEW)).toEqual({ x: 50, y: 8 })
  })
})

describe('placeMenu / button anchor (`›`)', () => {
  const button = { kind: 'button' as const, left: 700, right: 720, top: 100, bottom: 120 }
  it('right edge aligned with the button, below it', () => {
    expect(placeMenu(button, SIZE, VIEW)).toEqual({ x: 520, y: 120 })
  })
  it('flips above the button when there is no room below', () => {
    expect(placeMenu({ ...button, top: 450, bottom: 470 }, SIZE, VIEW)).toEqual({ x: 520, y: 150 })
  })
  it('a button near the left edge still keeps the menu inside', () => {
    expect(placeMenu({ ...button, left: 10, right: 30 }, SIZE, VIEW)).toEqual({ x: 8, y: 120 })
  })
})

describe('menuBounds', () => {
  it('is the viewport without a panel, the intersection with it otherwise', () => {
    expect(menuBounds({ width: 800, height: 600 }, null)).toEqual(VIEW)
    expect(menuBounds({ width: 800, height: 600 }, { left: 400, top: -50, right: 900, bottom: 500 }))
      .toEqual({ left: 400, top: 0, right: 800, bottom: 500 })
  })
  it('panel bounds keep the menu inside the Git panel', () => {
    const bounds = menuBounds({ width: 1200, height: 800 }, { left: 800, top: 0, right: 1200, bottom: 800 })
    expect(placeMenu({ kind: 'point', x: 1150, y: 40 }, SIZE, bounds)).toEqual({ x: 992, y: 40 })
    expect(placeMenu({ kind: 'point', x: 700, y: 40 }, SIZE, bounds)).toEqual({ x: 808, y: 40 })
  })
})

describe('menuPlacement (I-1: focus only once placed)', () => {
  it('no anchor: document flow, ready at once', () => {
    expect(menuPlacement(null, null)).toEqual({ style: undefined, ready: true })
  })
  it('measuring pass: at the origin, not ready, so the menu takes no focus yet', () => {
    const state = menuPlacement('a', null)
    expect(state.ready).toBe(false)
    expect(state.style).toMatchObject({ left: '0px', top: '0px' })
  })
  it('a placement for another anchor is stale: measuring again', () => {
    expect(menuPlacement('b', { key: 'a', x: 1, y: 2 }).ready).toBe(false)
  })
  it('placed: positioned, visible and ready for focus', () => {
    const state = menuPlacement('a', { key: 'a', x: 12, y: 34 })
    expect(state).toEqual({ style: { left: '12px', top: '34px' }, ready: true })
    expect(state.style?.visibility).toBeUndefined()
  })
})
