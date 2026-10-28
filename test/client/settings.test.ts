// B4a T1 workbench settings: parsing, clamping, legacy values, subscriptions and failure-tolerant storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  parseSettings,
  readChangelistGrouping,
  readDiffMode,
  readSettings,
  resetSettings,
  resetSettingsForTest,
  subscribeSettings,
  writeSettings,
} from '../../src/client/settings.ts'

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { values: Record<string, string> } {
  const values = { ...initial }
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value },
  }
}

beforeEach(() => { resetSettingsForTest() })
afterEach(() => {
  vi.unstubAllGlobals()
  resetSettingsForTest()
})

describe('parseSettings', () => {
  it('returns the defaults for missing or non-object input', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      autoRefresh: true,
      refreshIntervalSec: 3,
      diffMode: 'unified',
      logPageSize: 100,
      afterCommit: 'stay',
      dateFormat: 'absolute',
      compact: false,
      autoOpenConflicts: true,
      mergeAutoApplyNonConflicting: false,
      blameRenderer: false,
      changelistGrouping: false,
    })
    for (const raw of [undefined, null, 'x', 3, [1]]) expect(parseSettings(raw), String(raw)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back per field on wrong types and values outside the allowed set', () => {
    const parsed = parseSettings({
      autoRefresh: 'no',
      diffMode: 'sideways',
      logPageSize: 75,
      afterCommit: 'push',
      dateFormat: 'iso',
      compact: 1,
      autoOpenConflicts: null,
      mergeAutoApplyNonConflicting: 'true',
      blameRenderer: {},
      changelistGrouping: 'yes',
    })
    expect(parsed).toEqual(DEFAULT_SETTINGS)
  })

  it('accepts every allowed value', () => {
    const parsed = parseSettings({
      autoRefresh: false,
      refreshIntervalSec: 7,
      diffMode: 'split',
      logPageSize: 200,
      afterCommit: 'log',
      dateFormat: 'relative',
      compact: true,
      autoOpenConflicts: false,
      mergeAutoApplyNonConflicting: true,
      blameRenderer: true,
      changelistGrouping: true,
    })
    expect(parsed).toEqual({
      autoRefresh: false,
      refreshIntervalSec: 7,
      diffMode: 'split',
      logPageSize: 200,
      afterCommit: 'log',
      dateFormat: 'relative',
      compact: true,
      autoOpenConflicts: false,
      mergeAutoApplyNonConflicting: true,
      blameRenderer: true,
      changelistGrouping: true,
    })
    expect(parseSettings({ logPageSize: 50 }).logPageSize).toBe(50)
  })

  it('rounds and clamps the refresh interval to 1..10 seconds', () => {
    expect(parseSettings({ refreshIntervalSec: 0 }).refreshIntervalSec).toBe(1)
    expect(parseSettings({ refreshIntervalSec: -4 }).refreshIntervalSec).toBe(1)
    expect(parseSettings({ refreshIntervalSec: 42 }).refreshIntervalSec).toBe(10)
    expect(parseSettings({ refreshIntervalSec: 2.6 }).refreshIntervalSec).toBe(3)
    expect(parseSettings({ refreshIntervalSec: Number.NaN }).refreshIntervalSec).toBe(3)
    expect(parseSettings({ refreshIntervalSec: '5' }).refreshIntervalSec).toBe(3)
  })
})

describe('stored settings', () => {
  it('keeps the B3b/B3c values written by older builds', () => {
    expect(SETTINGS_KEY).toBe('dsh-idea-git.settings.v1')
    vi.stubGlobal('localStorage', memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ diffMode: 'split', changelistGrouping: true }) }))
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, diffMode: 'split', changelistGrouping: true })
    expect(readDiffMode()).toBe('split')
    expect(readChangelistGrouping()).toBe(true)
  })

  it('merges a patch, keeps unknown keys in storage and returns the parsed result', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ diffMode: 'split', future: 1 }) })
    vi.stubGlobal('localStorage', storage)
    const next = writeSettings({ compact: true, refreshIntervalSec: 99 })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, diffMode: 'split', compact: true, refreshIntervalSec: 10 })
    expect(JSON.parse(storage.values[SETTINGS_KEY] ?? '{}')).toEqual({ diffMode: 'split', future: 1, compact: true, refreshIntervalSec: 10 })
  })

  it('resetSettings restores the defaults but keeps the changelist grouping toggle', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ compact: true, changelistGrouping: true }) }))
    expect(resetSettings()).toEqual({ ...DEFAULT_SETTINGS, changelistGrouping: true })
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, changelistGrouping: true })
  })

  it('ignores corrupt JSON', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [SETTINGS_KEY]: '{oops' }))
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns the same snapshot until the stored value changes', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const first = readSettings()
    expect(readSettings()).toBe(first)
    writeSettings({ compact: true })
    const second = readSettings()
    expect(second).not.toBe(first)
    expect(readSettings()).toBe(second)
  })

  it('keeps working in memory when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceeded') },
    })
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => writeSettings({ compact: true })).not.toThrow()
    expect(readSettings().compact).toBe(true)
    resetSettingsForTest()
    vi.stubGlobal('localStorage', undefined)
    expect(writeSettings({ dateFormat: 'relative' }).dateFormat).toBe('relative')
    expect(readSettings().dateFormat).toBe('relative')
  })
})

describe('subscribeSettings', () => {
  it('notifies same-page subscribers on write and stops after unsubscribe', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const seen: boolean[] = []
    const unsubscribe = subscribeSettings((next) => { seen.push(next.compact) })
    writeSettings({ compact: true })
    unsubscribe()
    writeSettings({ compact: false })
    expect(seen).toEqual([true])
  })

  it('follows storage events of the settings key from other tabs', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const handlers: ((event: { key: string | null }) => void)[] = []
    vi.stubGlobal('addEventListener', (type: string, handler: (event: { key: string | null }) => void) => {
      if (type === 'storage') handlers.push(handler)
    })
    vi.stubGlobal('removeEventListener', (type: string, handler: (event: { key: string | null }) => void) => {
      const index = handlers.indexOf(handler)
      if (type === 'storage' && index >= 0) handlers.splice(index, 1)
    })
    const seen: string[] = []
    const unsubscribe = subscribeSettings((next) => { seen.push(next.dateFormat) })
    expect(handlers).toHaveLength(1)

    storage.values[SETTINGS_KEY] = JSON.stringify({ dateFormat: 'relative' })
    handlers[0]?.({ key: 'something-else' })
    expect(seen).toEqual([])
    handlers[0]?.({ key: SETTINGS_KEY })
    expect(seen).toEqual(['relative'])
    delete storage.values[SETTINGS_KEY]
    handlers[0]?.({ key: null })
    expect(seen).toEqual(['relative', 'absolute'])

    unsubscribe()
    expect(handlers).toHaveLength(0)
  })
})
