// B1 T6 host fullscreen of the merge window (AC10, controller ruling 5): enter only when the panel is
// not already fullscreen and not auto-fullscreen (<768px); leave only what the window itself entered.
import { describe, expect, it } from 'vitest'
import { AUTO_FULLSCREEN_MAX_WIDTH, decideFullscreen, decideFullscreenExit, isAutoFullscreenViewport } from '../../../src/client/pages/merge-fullscreen.ts'

describe('decideFullscreen', () => {
  it('decision table on open', () => {
    expect(decideFullscreen({ autoFullscreen: false, alreadyFullscreen: false })).toBe('enter')
    expect(decideFullscreen({ autoFullscreen: false, alreadyFullscreen: true })).toBe('none')
    expect(decideFullscreen({ autoFullscreen: true, alreadyFullscreen: false })).toBe('none')
    expect(decideFullscreen({ autoFullscreen: true, alreadyFullscreen: true })).toBe('none')
  })
})

describe('decideFullscreenExit', () => {
  it('exits only a fullscreen the window entered, still fullscreen, not auto', () => {
    expect(decideFullscreenExit({ enteredByUs: true, fullscreen: true, autoFullscreen: false })).toBe('exit')
    // The user already left fullscreen with the panel button: toggling would enter it again.
    expect(decideFullscreenExit({ enteredByUs: true, fullscreen: false, autoFullscreen: false })).toBe('none')
    // Toggling while auto-fullscreen collapses the panel (references §14).
    expect(decideFullscreenExit({ enteredByUs: true, fullscreen: true, autoFullscreen: true })).toBe('none')
    // The user was fullscreen before opening the window: keep it.
    expect(decideFullscreenExit({ enteredByUs: false, fullscreen: true, autoFullscreen: false })).toBe('none')
  })
})

describe('isAutoFullscreenViewport', () => {
  it('uses the sidebar threshold of 768px', () => {
    expect(AUTO_FULLSCREEN_MAX_WIDTH).toBe(768)
    expect(isAutoFullscreenViewport(767)).toBe(true)
    expect(isAutoFullscreenViewport(768)).toBe(false)
    expect(isAutoFullscreenViewport(1440)).toBe(false)
  })
})
