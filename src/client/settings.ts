// Viewer preferences kept per browser (design §13, plan b3b): today only the default diff mode.
// Storage can be missing or throw (private mode, sandboxed frames): reads fall back, writes are dropped.

/** localStorage key of the workbench settings (design §13). */
export const DIFF_SETTINGS_KEY = 'dsh-idea-git.settings.v1'

export type DiffMode = 'unified' | 'split'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? undefined
  } catch {
    return undefined
  }
}

function readSettings(): Record<string, unknown> {
  try {
    const raw = storage()?.getItem(DIFF_SETTINGS_KEY)
    const parsed: unknown = raw === null || raw === undefined ? {} : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function readDiffMode(): DiffMode {
  return readSettings().diffMode === 'split' ? 'split' : 'unified'
}

export function writeDiffMode(mode: DiffMode): void {
  try {
    storage()?.setItem(DIFF_SETTINGS_KEY, JSON.stringify({ ...readSettings(), diffMode: mode }))
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** B3c: whether the commit page groups changes by changelist. */
export function readChangelistGrouping(): boolean {
  return readSettings().changelistGrouping === true
}

export function writeChangelistGrouping(on: boolean): void {
  try {
    storage()?.setItem(DIFF_SETTINGS_KEY, JSON.stringify({ ...readSettings(), changelistGrouping: on }))
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
