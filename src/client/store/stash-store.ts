// Stash page state (design §8.4, plan A3 T10): the stash list, the selected stash (by sha, never by
// index — indexes shift when stashes are created or dropped) and the files of that stash.
// React-free; GitWorkbench creates one store per session and refreshes it by repository version.
import { useSyncExternalStore } from 'react'
import type {
  DiffRequest,
  GitError,
  RpcResult,
  StashEntry,
  StashFilesValue,
  StashListValue,
} from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'

export interface StashListState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last loaded entries (kept while reloading or after a failed reload). */
  entries: StashEntry[]
  version: number | undefined
  error: GitError | null
}

export interface StashFilesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The stash the state belongs to (null while idle). */
  sha: string | null
  value: StashFilesValue | null
  error: GitError | null
}

export interface StashStoreState {
  list: StashListState
  selectedSha: string | null
  files: StashFilesState
}

export interface StashStoreDeps {
  loadList: (signal?: AbortSignal) => Promise<RpcResult<StashListValue>>
  loadFiles: (sha: string, signal?: AbortSignal) => Promise<RpcResult<StashFilesValue>>
}

export interface StashStore {
  getState(): StashStoreState
  subscribe(listener: () => void): () => void
  /** Reload the list; an older response arriving late is dropped. */
  refresh(): Promise<void>
  /**
   * Select a stash (null clears) and load its files. Resolves with the files, or null when the
   * load failed or a newer selection superseded this one.
   */
  select(sha: string | null): Promise<StashFilesValue | null>
}

const IDLE_FILES: StashFilesState = { status: 'idle', sha: null, value: null, error: null }

const INITIAL: StashStoreState = {
  list: { status: 'idle', entries: [], version: undefined, error: null },
  selectedSha: null,
  files: IDLE_FILES,
}

function thrownError(error: unknown): GitError {
  return { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) }
}

export function createStashStore(deps: StashStoreDeps): StashStore {
  let state = INITIAL
  const listeners = new Set<() => void>()
  let listSeq = 0
  let filesSeq = 0
  let filesAbort: AbortController | null = null

  function setState(next: StashStoreState): void {
    state = next
    for (const listener of listeners) listener()
  }

  const store: StashStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => {
      const seq = ++listSeq
      setState({ ...state, list: { ...state.list, status: 'loading' } })
      let result: RpcResult<StashListValue>
      try {
        result = await deps.loadList()
      } catch (error) {
        result = { ok: false, error: thrownError(error) }
      }
      if (seq !== listSeq) return
      if (!result.ok) {
        setState({ ...state, list: { ...state.list, status: 'error', error: result.error } })
        return
      }
      const entries = result.value.entries
      setState({ ...state, list: { status: 'ready', entries, version: result.value.version, error: null } })
      // The selected stash is gone (dropped here or elsewhere): forget it instead of showing its files.
      if (state.selectedSha !== null && !entries.some(item => item.sha === state.selectedSha)) void store.select(null)
    },
    select: async (sha) => {
      if (sha === state.selectedSha && state.files.sha === sha && state.files.status === 'ready') return state.files.value
      const seq = ++filesSeq
      filesAbort?.abort()
      filesAbort = null
      if (sha === null) {
        setState({ ...state, selectedSha: null, files: IDLE_FILES })
        return null
      }
      const abort = new AbortController()
      filesAbort = abort
      setState({ ...state, selectedSha: sha, files: { status: 'loading', sha, value: null, error: null } })
      let result: RpcResult<StashFilesValue>
      try {
        result = await deps.loadFiles(sha, abort.signal)
      } catch (error) {
        result = { ok: false, error: thrownError(error) }
      }
      if (seq !== filesSeq) return null
      if (!result.ok) {
        setState({ ...state, files: { status: 'error', sha, value: null, error: result.error } })
        return null
      }
      setState({ ...state, files: { status: 'ready', sha, value: result.value, error: null } })
      return result.value
    },
  }
  return store
}

export function useStashState(store: StashStore): StashStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type StashFileKind = 'tracked' | 'untracked'

/**
 * Preview diff of one stash file through the `diff` endpoint: tracked files compare the stash
 * commit with its first parent; untracked files live in the stash's third parent (a root commit,
 * everything added). Null when an untracked file has no such commit.
 */
export function stashDiffRequest(
  sessionId: string,
  value: Pick<StashFilesValue, 'sha' | 'parentSha' | 'untrackedSha'>,
  kind: StashFileKind,
  path: string,
): DiffRequest | null {
  if (kind === 'tracked') return { sessionId, scope: 'commit', sha: value.sha, parent: value.parentSha, path }
  if (value.untrackedSha === null) return null
  return { sessionId, scope: 'commit', sha: value.untrackedSha, path }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now / N minutes ago / N hours ago / N days ago", then the plain date. */
export function stashRelativeTime(iso: string, now: number): LocalizedText {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return text('stash.time.date', { date: iso })
  const elapsed = Math.max(0, now - time)
  if (elapsed < MINUTE) return text('stash.time.now')
  if (elapsed < HOUR) return text('stash.time.minutes', { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return text('stash.time.hours', { count: Math.floor(elapsed / HOUR) })
  if (elapsed < 30 * DAY) return text('stash.time.days', { count: Math.floor(elapsed / DAY) })
  return text('stash.time.date', { date: new Date(time).toISOString().slice(0, 10) })
}

const SUMMARY_LIMIT = 60

/** First line of a stash message, shortened for the delete confirmation. */
export function stashSummary(message: string): string {
  const line = message.split('\n')[0] ?? ''
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

/** Arrow-key navigation inside the list (clamped, no wrap-around). */
export function adjacentStash(entries: readonly StashEntry[], current: string | null, key: string): string | null {
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null
  if (entries.length === 0) return null
  const index = entries.findIndex(item => item.sha === current)
  if (index < 0) return entries[0]?.sha ?? null
  const next = Math.min(entries.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)))
  return entries[next]?.sha ?? null
}

export type StashKeyAction = 'preview' | 'delete'

/** Keys of a focused list row: Enter previews, Delete asks to delete (never deletes directly). */
export function stashKeyAction(key: string): StashKeyAction | null {
  if (key === 'Enter') return 'preview'
  if (key === 'Delete') return 'delete'
  return null
}

/** Delete is available only when nothing blocks it (read-only) and no stash write is running. */
export function canDropStash(busy: boolean, dropBlock: unknown): boolean {
  return !busy && dropBlock === undefined
}

export type StashRowKeyDecision =
  | { kind: 'move'; sha: string }
  | { kind: 'preview' }
  | { kind: 'askDrop' }
  | { kind: 'none' }

/** What a key on a focused stash row does; Delete does nothing while delete is gated off. */
export function stashRowKeyDecision(
  entries: readonly StashEntry[],
  current: string,
  key: string,
  canDrop: boolean,
): StashRowKeyDecision {
  const move = adjacentStash(entries, current, key)
  if (move !== null) return { kind: 'move', sha: move }
  // B4b: Space selects the focused row (WAI-ARIA listbox).
  if (key === ' ' && entries.some(item => item.sha === current)) return { kind: 'move', sha: current }
  const action = stashKeyAction(key)
  if (action === 'preview') return { kind: 'preview' }
  if (action === 'delete' && canDrop) return { kind: 'askDrop' }
  return { kind: 'none' }
}
