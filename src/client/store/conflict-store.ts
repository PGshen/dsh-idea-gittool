// Conflict list state (design §10.1–10.2, plan A3 T9): the Host's operationState, its two groups,
// the side labels by concrete names (ours/theirs only in tooltips) and the once-per-operation
// auto-open rule. React-free; the workbench creates one store per session.
import { useSyncExternalStore } from 'react'
import type {
  ConflictKind,
  ConflictResolution,
  FileEntry,
  GitError,
  OperationStateValue,
  RepoOperation,
  RpcResult,
} from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'

export interface ConflictStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last loaded state (kept while reloading or after a failed reload). */
  value: OperationStateValue | null
  error: GitError | null
}

export interface ConflictStoreDeps {
  load: (signal?: AbortSignal) => Promise<RpcResult<OperationStateValue>>
}

export interface ConflictStore {
  getState(): ConflictStoreState
  subscribe(listener: () => void): () => void
  /** Reload operationState; an older response arriving late is dropped. */
  refresh(): Promise<void>
  /** No operation any more: drop the value. */
  clear(): void
}

const IDLE: ConflictStoreState = { status: 'idle', value: null, error: null }

export function createConflictStore(deps: ConflictStoreDeps): ConflictStore {
  const listeners = new Set<() => void>()
  let state = IDLE
  let seq = 0

  const emit = (next: ConflictStoreState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => {
      const mine = ++seq
      emit({ ...state, status: 'loading' })
      let result: RpcResult<OperationStateValue>
      try {
        result = await deps.load()
      } catch (error) {
        result = { ok: false, error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) } }
      }
      if (mine !== seq) return
      emit(result.ok
        ? { status: 'ready', value: result.value, error: null }
        : { status: 'error', value: state.value, error: result.error })
    },
    clear: () => {
      seq += 1
      if (state !== IDLE) emit(IDLE)
    },
  }
}

export function useConflictState(store: ConflictStore): ConflictStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

// ---------------------------------------------------------------------------
// Groups and labels
// ---------------------------------------------------------------------------

export interface ConflictGroups {
  unresolved: FileEntry[]
  resolved: string[]
}

export function conflictGroups(value: OperationStateValue | null): ConflictGroups {
  if (value === null) return { unresolved: [], resolved: [] }
  const open = new Set(value.conflicts.map(entry => entry.path))
  return { unresolved: value.conflicts, resolved: value.resolved.filter(path => !open.has(path)) }
}

export interface SideText {
  /** "main（当前分支）". */
  name: LocalizedText
  /** "采用 main". */
  take: LocalizedText
  /** Tooltip with the technical ours/theirs meaning. */
  title: LocalizedText
}

export interface ConflictSides {
  ours: SideText
  theirs: SideText
  /** Rebase only: Git's ours is the target branch. */
  note: LocalizedText | null
}

const THEIRS_NAME: Record<Exclude<RepoOperation, null>, GitWorkbenchKey> = {
  merge: 'conflict.side.merged',
  bisect: 'conflict.side.merged',
  rebase: 'conflict.side.replayed',
  'cherry-pick': 'conflict.side.picked',
  revert: 'conflict.side.reverted',
}

/**
 * Both sides named as the user knows them (design §10.1 table): merge ours = current branch,
 * theirs = merged branch; rebase ours = target branch, theirs = the replayed branch's commits;
 * cherry-pick / revert ours = current branch, theirs = the commit.
 */
export function conflictSides(value: OperationStateValue): ConflictSides {
  if (value.operation === null) return stashPopSides(value)
  const rebase = value.operation === 'rebase'
  const oursName = text(rebase ? 'conflict.side.onto' : 'conflict.side.current', { label: value.ours.label })
  const theirsName = text(THEIRS_NAME[value.operation ?? 'merge'], { label: value.theirs.label })
  return {
    ours: {
      name: oursName,
      take: text('conflict.take', { label: value.ours.label }),
      title: text(rebase ? 'conflict.take.ours.titleRebase' : 'conflict.take.ours.title', { label: value.ours.label }),
    },
    theirs: {
      name: theirsName,
      take: text('conflict.take', { label: value.theirs.label }),
      title: text(rebase ? 'conflict.take.theirs.titleRebase' : 'conflict.take.theirs.title', { label: value.theirs.label }),
    },
    note: rebase ? text('conflict.rebaseNote', { ours: value.ours.label, theirs: value.theirs.label }) : null,
  }
}

/**
 * Carry 4: no operation but unmerged entries — restoring the stash after an integrate / pull
 * conflicted. `git stash pop`: ours = HEAD (the current branch), theirs = the stashed changes.
 */
function stashPopSides(value: OperationStateValue): ConflictSides {
  return {
    ours: {
      name: text('conflict.side.current', { label: value.ours.label }),
      take: text('conflict.take', { label: value.ours.label }),
      title: text('conflict.take.ours.title', { label: value.ours.label }),
    },
    theirs: {
      name: text('conflict.stashLabel'),
      take: text('conflict.take', { label: value.theirs.label }),
      title: text('conflict.take.stash.title'),
    },
    note: null,
  }
}

/**
 * The Host leaves `theirs.label` empty without an operation; name it "the stashed changes"
 * (`stashLabel`, already translated) so every row text has a side name.
 */
export function withStashLabel(value: OperationStateValue, stashLabel: string): OperationStateValue {
  if (value.operation !== null || value.theirs.label !== '') return value
  return { ...value, theirs: { ...value.theirs, label: stashLabel } }
}

export interface ConflictListSync {
  /** Reload operationState, or drop the value. */
  load: 'clear' | 'refresh'
  /** The list had something to show and now has nothing: close it. */
  close: boolean
  /** Feed back as `previousActive` next time. */
  active: boolean
}

/**
 * What the conflict list does when the status changes: it is active while an operation runs or
 * unmerged entries remain without one (carry 4: the stash pop after an integrate conflicted).
 */
export function conflictListSync(previousActive: boolean, operation: RepoOperation, conflicts: number): ConflictListSync {
  const active = operation !== null || conflicts > 0
  return { load: active ? 'refresh' : 'clear', close: previousActive && !active, active }
}

export type ConflictActionId = 'ours' | 'theirs' | 'keep' | 'delete' | 'mark'

export interface ConflictRowAction {
  id: ConflictActionId
  resolution: ConflictResolution
  label: LocalizedText
  title: LocalizedText
}

/** Side that still has the file for the one-sided kinds (the other side deleted or never had it). */
const KEEP_SIDE: Partial<Record<ConflictKind, 'ours' | 'theirs'>> = {
  'deleted-by-us': 'theirs',
  'deleted-by-them': 'ours',
  'added-by-us': 'ours',
  'added-by-them': 'theirs',
}

/**
 * Buttons of one unresolved row. Content conflicts: take ours / take theirs (by name) and mark
 * resolved. One side deleted the file (DU/UD): keep (= the side that has it) / delete — the Host
 * treats ours/theirs of a deleting side as a delete. Both deleted: delete only.
 */
export function conflictRowActions(entry: FileEntry, value: OperationStateValue): ConflictRowAction[] {
  const sides = conflictSides(value)
  const kind = entry.conflict
  if (kind === 'both-deleted') {
    return [{ id: 'delete', resolution: 'delete', label: text('conflict.delete'), title: text('conflict.delete.plainTitle') }]
  }
  const keep = kind === undefined ? undefined : KEEP_SIDE[kind]
  if (keep !== undefined) {
    const label = (side: 'ours' | 'theirs'): string => value[side].label
    const other = keep === 'ours' ? 'theirs' : 'ours'
    const deletedByOther = kind === 'deleted-by-us' || kind === 'deleted-by-them'
    return [
      { id: 'keep', resolution: keep, label: text('conflict.keep'), title: text('conflict.keep.title', { label: label(keep) }) },
      {
        id: 'delete',
        resolution: 'delete',
        label: text('conflict.delete'),
        title: deletedByOther ? text('conflict.delete.title', { label: label(other) }) : text('conflict.delete.plainTitle'),
      },
    ]
  }
  return [
    { id: 'ours', resolution: 'ours', label: sides.ours.take, title: sides.ours.title },
    { id: 'theirs', resolution: 'theirs', label: sides.theirs.take, title: sides.theirs.title },
    { id: 'mark', resolution: 'mark-resolved', label: text('conflict.markResolved'), title: text('conflict.markResolved.title') },
  ]
}

/** Short description of the conflict kind, naming the side where it matters. */
export function conflictKindText(entry: FileEntry, value: OperationStateValue): LocalizedText {
  const kind = entry.conflict ?? 'both-modified'
  return text(`conflict.kind.${kind}`, { ours: value.ours.label, theirs: value.theirs.label })
}

// ---------------------------------------------------------------------------
// Auto-open (design §10.1: once per operation, never again after the user closed it)
// ---------------------------------------------------------------------------

/**
 * Stable identity of one operation across its steps: the operation kind, ours (HEAD for
 * merge/cherry-pick/revert, onto for rebase) and theirs (MERGE_HEAD / the picked commit; the
 * replayed branch name for rebase, whose current commit changes every step).
 */
export function operationIdentity(value: OperationStateValue): string | null {
  if (value.operation === null) return null
  const ours = value.ours.sha ?? value.ours.label
  const theirs = value.operation === 'rebase' ? value.theirs.label : (value.theirs.sha ?? value.theirs.label)
  return `${value.operation}|${ours}|${theirs}`
}

export interface AutoOpenTracker {
  /**
   * Feed every loaded state (null: no operation). True when the conflict list should open now:
   * an operation that started after an idle state was seen has conflicts and was never shown.
   */
  observe(value: OperationStateValue | null): boolean
  /** The list was opened (any way): the current — or the next observed — operation counts as shown. */
  noteOpened(): void
}

export function createAutoOpenTracker(): AutoOpenTracker {
  const shown = new Set<string>()
  let sawIdle = false
  let current: string | null = null
  let pendingMark = false

  return {
    observe: (value) => {
      const key = value === null ? null : operationIdentity(value)
      current = key
      if (key === null) {
        // Carry 11: idle again — a later run of the same operation is a new one and may open.
        sawIdle = true
        shown.clear()
        return false
      }
      if (pendingMark || !sawIdle) {
        // Opened before the state loaded, or already in progress when the workbench mounted.
        pendingMark = false
        shown.add(key)
        return false
      }
      if (shown.has(key) || value === null || value.conflicts.length === 0) return false
      shown.add(key)
      return true
    },
    noteOpened: () => {
      if (current === null) pendingMark = true
      else shown.add(current)
    },
  }
}
