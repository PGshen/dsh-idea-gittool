// Client feature flags (B1). A flag has a compiled-in default; a viewer can override it
// per browser with localStorage (`'1'` on, `'0'` off). Any storage failure means the default.

/** Three-way merge window and the enhanced conflict list (B1); on since owner acceptance (2026-10-27). */
export const MERGE_WINDOW_DEFAULT = true

/** localStorage key that overrides {@link MERGE_WINDOW_DEFAULT}. */
export const MERGE_WINDOW_STORAGE_KEY = 'dsh-git.feature.mergeWindow'

/** Interactive rebase and its log quick actions (B3a); off until owner acceptance. */
export const INTERACTIVE_REBASE_DEFAULT = false

/** localStorage key that overrides {@link INTERACTIVE_REBASE_DEFAULT}. */
export const INTERACTIVE_REBASE_STORAGE_KEY = 'dsh-git.feature.interactiveRebase'

/** Worktree page and "check out in a new worktree" (B3d); off until owner acceptance. */
export const WORKTREES_DEFAULT = false

/** localStorage key that overrides {@link WORKTREES_DEFAULT}. */
export const WORKTREES_STORAGE_KEY = 'dsh-git.feature.worktrees'

export type FeatureName = 'mergeWindow' | 'interactiveRebase' | 'worktrees'

const FEATURES: Readonly<Record<FeatureName, { defaultValue: boolean; storageKey: string }>> = {
  mergeWindow: { defaultValue: MERGE_WINDOW_DEFAULT, storageKey: MERGE_WINDOW_STORAGE_KEY },
  interactiveRebase: { defaultValue: INTERACTIVE_REBASE_DEFAULT, storageKey: INTERACTIVE_REBASE_STORAGE_KEY },
  worktrees: { defaultValue: WORKTREES_DEFAULT, storageKey: WORKTREES_STORAGE_KEY },
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
