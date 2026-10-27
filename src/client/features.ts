// Client feature flags (B1). A flag has a compiled-in default; a viewer can override it
// per browser with localStorage (`'1'` on, `'0'` off). Any storage failure means the default.

/** Three-way merge window and the enhanced conflict list (B1); on since owner acceptance (2026-10-27). */
export const MERGE_WINDOW_DEFAULT = true

/** localStorage key that overrides {@link MERGE_WINDOW_DEFAULT}. */
export const MERGE_WINDOW_STORAGE_KEY = 'dsh-git.feature.mergeWindow'

export type FeatureName = 'mergeWindow'

const FEATURES: Readonly<Record<FeatureName, { defaultValue: boolean; storageKey: string }>> = {
  mergeWindow: { defaultValue: MERGE_WINDOW_DEFAULT, storageKey: MERGE_WINDOW_STORAGE_KEY },
}

function readOverride(key: string): string | null {
  try {
    const storage = (globalThis as { localStorage?: Pick<Storage, 'getItem'> | undefined }).localStorage
    return storage === undefined || storage === null ? null : storage.getItem(key)
  } catch {
    // Blocked storage (privacy mode, sandboxed frame) throws on access: keep the default.
    return null
  }
}

/** Whether a feature is on for this browser: `'1'`/`'0'` in localStorage override the default. */
export function isFeatureEnabled(name: FeatureName): boolean {
  const feature = FEATURES[name]
  const override = readOverride(feature.storageKey)
  if (override === '1') return true
  if (override === '0') return false
  return feature.defaultValue
}
