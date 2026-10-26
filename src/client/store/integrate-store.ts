// Form defaults and request builders of the integrate pages (A3 T8): merge / rebase / pull /
// update project / reset / fetch. React-free.
// Remembered per browser: the last merge option, pull and update mode, prune, and the soft/mixed
// reset mode. Risk checkboxes (hard reset tick, "create backup branch") are never stored: every
// open starts from the safe default.
import type { PullMode, ResetMode, StatusValue } from '../../shared/protocol.ts'
import type { KeyValueStorage } from './push-store.ts'

export { browserStorage } from './push-store.ts'

export type MergeOption = 'default' | 'noFf' | 'squash' | 'noCommit'

export const MERGE_OPTIONS: readonly MergeOption[] = ['default', 'noFf', 'squash', 'noCommit']
export const PULL_MODES: readonly PullMode[] = ['merge', 'rebase']
export const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard']

export interface IntegratePrefs {
  merge: MergeOption
  pull: PullMode
  update: PullMode
  prune: boolean
  /** Never `hard`: a destructive mode is not pre-selected on the next open. */
  reset: Exclude<ResetMode, 'hard'>
}

export const DEFAULT_PREFS: IntegratePrefs = { merge: 'default', pull: 'merge', update: 'merge', prune: false, reset: 'mixed' }

export const PREFS_KEY = 'dsh-git.integrate.v1'

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** Stored preferences, validated field by field; anything unusable falls back to the default. */
export function loadPrefs(storage: KeyValueStorage | null): IntegratePrefs {
  if (storage === null) return DEFAULT_PREFS
  try {
    const raw = storage.getItem(PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const data = JSON.parse(raw) as Record<string, unknown> | null
    if (typeof data !== 'object' || data === null) return DEFAULT_PREFS
    return {
      merge: pick(data['merge'], MERGE_OPTIONS, DEFAULT_PREFS.merge),
      pull: pick(data['pull'], PULL_MODES, DEFAULT_PREFS.pull),
      update: pick(data['update'], PULL_MODES, DEFAULT_PREFS.update),
      prune: data['prune'] === true,
      reset: pick(data['reset'], ['soft', 'mixed'] as const, DEFAULT_PREFS.reset),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Store the choices worth remembering (a `hard` reset mode is stored as the default). */
export function savePrefs(storage: KeyValueStorage | null, prefs: IntegratePrefs): void {
  if (storage === null) return
  const safe: IntegratePrefs = { ...prefs, reset: prefs.reset === 'soft' ? 'soft' : 'mixed' }
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(safe))
  } catch {
    // Private mode / blocked site data: the form still works, it just forgets.
  }
}

export interface MergePayload {
  ref: string
  noFf?: true
  squash?: true
  noCommit?: true
}

/** Merge option → request flags. */
export function mergeRequestOf(ref: string, option: MergeOption): MergePayload {
  switch (option) {
    case 'noFf': return { ref, noFf: true }
    case 'squash': return { ref, squash: true }
    case 'noCommit': return { ref, noCommit: true }
    case 'default': return { ref }
  }
}

/** `origin/feat/x` against the known remotes: the longest remote that prefixes it wins. */
export function resolveRemoteRef(remotes: readonly string[], ref: string): { remote: string; branch: string } | null {
  let best: string | null = null
  for (const remote of remotes) {
    if (!ref.startsWith(`${remote}/`) || ref.length === remote.length + 1) continue
    if (best === null || remote.length > best.length) best = remote
  }
  return best === null ? null : { remote: best, branch: ref.slice(best.length + 1) }
}

export interface PullDefaultsInput {
  remotes: readonly string[]
  defaultRemote: string | null
  /** `origin/main` of the current branch. */
  upstream: string | null
  /** Current branch; null when detached. */
  branch: string | null
  /** From a branch row: `remote` may be a prefix of a remote name that contains '/'. */
  prefill?: { remote?: string; branch?: string } | undefined
}

/** Remote and branch the pull form starts with. */
export function pullDefaults(input: PullDefaultsInput): { remote: string; branch: string } {
  const { prefill } = input
  if (prefill?.remote !== undefined && prefill.branch !== undefined) {
    const resolved = resolveRemoteRef(input.remotes, `${prefill.remote}/${prefill.branch}`)
    if (resolved !== null) return resolved
    return { remote: prefill.remote, branch: prefill.branch }
  }
  if (input.upstream !== null) {
    const resolved = resolveRemoteRef(input.remotes, input.upstream)
    if (resolved !== null) return resolved
  }
  return { remote: input.defaultRemote ?? input.remotes[0] ?? '', branch: input.branch ?? '' }
}

/** Staged or unstaged changes (untracked files do not count: smart operations leave them alone). */
export function hasTrackedChanges(status: StatusValue | null): boolean {
  return status !== null && (status.staged.length > 0 || status.unstaged.length > 0 || status.conflicts.length > 0)
}
