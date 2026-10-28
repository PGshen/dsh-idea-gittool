// Viewer preferences kept per browser (design §13, plan b4a): one JSON object under SETTINGS_KEY.
// Storage can be missing or throw (private mode, sandboxed frames): reads fall back to the
// defaults, and a failed write keeps the value in memory for this page.
import { useSyncExternalStore } from 'react'

/** localStorage key of the workbench settings (design §13). */
export const SETTINGS_KEY = 'dsh-idea-git.settings.v1'

/** @deprecated B3b name of {@link SETTINGS_KEY}. */
export const DIFF_SETTINGS_KEY = SETTINGS_KEY

export type DiffMode = 'unified' | 'split'
export type LogPageSize = 50 | 100 | 200
export type AfterCommit = 'stay' | 'log'
export type DateFormat = 'absolute' | 'relative'

export interface WorkbenchSettings {
  autoRefresh: boolean
  /** Whole seconds, 1..10. */
  refreshIntervalSec: number
  diffMode: DiffMode
  logPageSize: LogPageSize
  afterCommit: AfterCommit
  dateFormat: DateFormat
  /** Log table: 24px rows, no author/hash columns. */
  compact: boolean
  autoOpenConflicts: boolean
  mergeAutoApplyNonConflicting: boolean
  /** Register the "Git Blame" document renderer (it becomes the default code viewer). */
  blameRenderer: boolean
  /** B3c: commit page groups changes by changelist (toggled on that page, not in the sheet). */
  changelistGrouping: boolean
}

export const DEFAULT_SETTINGS: Readonly<WorkbenchSettings> = Object.freeze({
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

export const REFRESH_INTERVAL_MIN_SEC = 1
export const REFRESH_INTERVAL_MAX_SEC = 10
export const LOG_PAGE_SIZES: readonly LogPageSize[] = [50, 100, 200]

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Rounds and clamps to 1..10 seconds; anything but a finite number gives the default. */
export function clampRefreshInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.refreshIntervalSec
  return Math.min(REFRESH_INTERVAL_MAX_SEC, Math.max(REFRESH_INTERVAL_MIN_SEC, Math.round(value)))
}

/** Stored JSON → settings; every field falls back to its default on its own. */
export function parseSettings(raw: unknown): WorkbenchSettings {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const d = DEFAULT_SETTINGS
  return {
    autoRefresh: bool(source.autoRefresh, d.autoRefresh),
    refreshIntervalSec: clampRefreshInterval(source.refreshIntervalSec),
    diffMode: oneOf(source.diffMode, ['unified', 'split'] as const, d.diffMode),
    logPageSize: oneOf(source.logPageSize, LOG_PAGE_SIZES, d.logPageSize),
    afterCommit: oneOf(source.afterCommit, ['stay', 'log'] as const, d.afterCommit),
    dateFormat: oneOf(source.dateFormat, ['absolute', 'relative'] as const, d.dateFormat),
    compact: bool(source.compact, d.compact),
    autoOpenConflicts: bool(source.autoOpenConflicts, d.autoOpenConflicts),
    mergeAutoApplyNonConflicting: bool(source.mergeAutoApplyNonConflicting, d.mergeAutoApplyNonConflicting),
    blameRenderer: bool(source.blameRenderer, d.blameRenderer),
    changelistGrouping: bool(source.changelistGrouping, d.changelistGrouping),
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? undefined
  } catch {
    return undefined
  }
}

/** Set once a write failed: the page keeps using this object instead of storage. */
let memory: Record<string, unknown> | null = null
let cachedKey: string | null | undefined
let cached: WorkbenchSettings = { ...DEFAULT_SETTINGS }
const listeners = new Set<(next: WorkbenchSettings) => void>()

function rawStored(): string | null {
  if (memory !== null) return JSON.stringify(memory)
  try {
    return storage()?.getItem(SETTINGS_KEY) ?? null
  } catch {
    return null
  }
}

function objectOf(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Current settings; the same object until the stored value changes (useSyncExternalStore snapshot). */
export function readSettings(): WorkbenchSettings {
  const raw = rawStored()
  if (raw !== cachedKey) {
    cachedKey = raw
    cached = parseSettings(objectOf(raw))
  }
  return cached
}

function store(next: Record<string, unknown>): WorkbenchSettings {
  const serialized = JSON.stringify(next)
  if (memory === null) {
    try {
      const target = storage()
      if (target === undefined) throw new Error('no storage')
      target.setItem(SETTINGS_KEY, serialized)
    } catch {
      memory = next
    }
  } else {
    memory = next
  }
  const settings = readSettings()
  for (const listener of [...listeners]) listener(settings)
  return settings
}

/** Merges `patch` into the stored object (unknown keys survive) and notifies subscribers. */
export function writeSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings {
  const merged: Record<string, unknown> = { ...objectOf(rawStored()), ...patch }
  if ('refreshIntervalSec' in patch) merged.refreshIntervalSec = clampRefreshInterval(patch.refreshIntervalSec)
  return store(merged)
}

/** Back to the defaults; the commit page's changelist grouping is not a sheet setting and stays. */
export function resetSettings(): WorkbenchSettings {
  const { changelistGrouping } = readSettings()
  return store({ ...DEFAULT_SETTINGS, changelistGrouping })
}

type StorageEventTarget = {
  addEventListener?: (type: 'storage', handler: (event: { key: string | null }) => void) => void
  removeEventListener?: (type: 'storage', handler: (event: { key: string | null }) => void) => void
}

function onStorage(event: { key: string | null }): void {
  // key null: another tab called localStorage.clear().
  if (event.key !== SETTINGS_KEY && event.key !== null) return
  const settings = readSettings()
  for (const listener of [...listeners]) listener(settings)
}

/** Same-page writes and other tabs' writes (storage event); returns the unsubscribe. */
export function subscribeSettings(listener: (next: WorkbenchSettings) => void): () => void {
  if (listeners.size === 0) (globalThis as StorageEventTarget).addEventListener?.('storage', onStorage)
  listeners.add(listener)
  return () => {
    if (!listeners.delete(listener)) return
    if (listeners.size === 0) (globalThis as StorageEventTarget).removeEventListener?.('storage', onStorage)
  }
}

/** React view of the settings. */
export function useSettings(): WorkbenchSettings {
  return useSyncExternalStore(subscribeSettings, readSettings, readSettings)
}

/** Test hook: forget the in-memory fallback and cached snapshot. */
export function resetSettingsForTest(): void {
  memory = null
  cachedKey = undefined
  cached = { ...DEFAULT_SETTINGS }
}

export function readDiffMode(): DiffMode {
  return readSettings().diffMode
}

export function writeDiffMode(mode: DiffMode): void {
  writeSettings({ diffMode: mode })
}

export function readChangelistGrouping(): boolean {
  return readSettings().changelistGrouping
}

export function writeChangelistGrouping(on: boolean): void {
  writeSettings({ changelistGrouping: on })
}
