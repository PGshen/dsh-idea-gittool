// B1 T1 feature flags: defaults, localStorage override, and failure-tolerant reads.
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  INTERACTIVE_REBASE_DEFAULT,
  INTERACTIVE_REBASE_STORAGE_KEY,
  MERGE_WINDOW_DEFAULT,
  MERGE_WINDOW_STORAGE_KEY,
  isFeatureEnabled,
} from '../../src/client/features.ts'

function storage(values: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => values[key] ?? null }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('isFeatureEnabled', () => {
  it('mergeWindow defaults to on (accepted 2026-10-27) and uses the documented storage key', () => {
    expect(MERGE_WINDOW_DEFAULT).toBe(true)
    expect(MERGE_WINDOW_STORAGE_KEY).toBe('dsh-git.feature.mergeWindow')
    vi.stubGlobal('localStorage', storage({}))
    expect(isFeatureEnabled('mergeWindow')).toBe(MERGE_WINDOW_DEFAULT)
  })

  it("'1' turns it on and '0' turns it off", () => {
    vi.stubGlobal('localStorage', storage({ 'dsh-git.feature.mergeWindow': '1' }))
    expect(isFeatureEnabled('mergeWindow')).toBe(true)
    vi.stubGlobal('localStorage', storage({ 'dsh-git.feature.mergeWindow': '0' }))
    expect(isFeatureEnabled('mergeWindow')).toBe(false)
  })

  it('ignores any other stored value', () => {
    for (const value of ['', 'true', 'yes', ' 1', '2']) {
      vi.stubGlobal('localStorage', storage({ 'dsh-git.feature.mergeWindow': value }))
      expect(isFeatureEnabled('mergeWindow'), value).toBe(MERGE_WINDOW_DEFAULT)
    }
  })

  it('falls back to the default when localStorage throws or is missing', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError') } })
    expect(isFeatureEnabled('mergeWindow')).toBe(MERGE_WINDOW_DEFAULT)
    vi.stubGlobal('localStorage', undefined)
    expect(isFeatureEnabled('mergeWindow')).toBe(MERGE_WINDOW_DEFAULT)
    // Accessing the global itself can throw (sandboxed iframes, blocked storage).
    vi.unstubAllGlobals()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
    try {
      expect(isFeatureEnabled('mergeWindow')).toBe(MERGE_WINDOW_DEFAULT)
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
      else Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})

describe('interactiveRebase flag (B3a)', () => {
  it('defaults to on since owner acceptance (2026-10-28) and uses the documented storage key', () => {
    expect(INTERACTIVE_REBASE_DEFAULT).toBe(true)
    expect(INTERACTIVE_REBASE_STORAGE_KEY).toBe('dsh-git.feature.interactiveRebase')
    vi.stubGlobal('localStorage', storage({}))
    expect(isFeatureEnabled('interactiveRebase')).toBe(true)
  })

  it("'1' turns it on and '0' turns it off, independent of mergeWindow", () => {
    vi.stubGlobal('localStorage', storage({ 'dsh-git.feature.interactiveRebase': '1', 'dsh-git.feature.mergeWindow': '0' }))
    expect(isFeatureEnabled('interactiveRebase')).toBe(true)
    expect(isFeatureEnabled('mergeWindow')).toBe(false)
    vi.stubGlobal('localStorage', storage({ 'dsh-git.feature.interactiveRebase': '0' }))
    expect(isFeatureEnabled('interactiveRebase')).toBe(false)
  })
})
