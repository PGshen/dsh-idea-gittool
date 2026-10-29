// Conflict list state (design §10.1–10.2, plan A3 T9): the Host's operationState, its two groups,
// the side labels by concrete names (ours/theirs only in tooltips) and the once-per-operation
// auto-open rule. React-free; the workbench creates one store per session.
// B1 T7 (mergeWindow flag): the in-memory reviewed state of Review Changes (decision D5), lazy chunk
// counts per file, the bottom button / review queue rules and row selection.
import { useSyncExternalStore } from 'react'
import type {
  ConflictKind,
  ConflictResolution,
  FileEntry,
  GitError,
  MergeFileValue,
  OperationStateValue,
  RepoOperation,
  RpcResult,
} from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import { counts as chunkCounts, createModel } from '../merge/merge-model.ts'
import { mergeTexts } from './merge-store.ts'

export interface ConflictStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last loaded state (kept while reloading or after a failed reload). */
  value: OperationStateValue | null
  error: GitError | null
  /**
   * T2: where conflicts without an operation came from (absent = restoring a stash). Set by the
   * workbench when a shelf three-way apply left conflicts; {@link ConflictStore.clear} forgets it.
   */
  origin?: ConflictOrigin
}

/** Source of conflicts left without an operation in progress. */
export type ConflictOrigin = 'stash' | 'shelf'

export interface ConflictStoreDeps {
  load: (signal?: AbortSignal) => Promise<RpcResult<OperationStateValue>>
  /** B1 T7: `mergeFile`, for the chunk counts of the list (without it {@link ConflictStore.loadCounts} does nothing). */
  loadFile?: (path: string, signal?: AbortSignal) => Promise<RpcResult<MergeFileValue>>
}

/** Resolved / total conflict chunks of one file (as the merge window counts them). */
export interface ChunkCount {
  resolved: number
  total: number
}

/** B1 T7 state kept next to the operation state (in memory only, decision D5). */
export interface ConflictReview {
  /** {@link reviewKey} of the operation (and rebase step) the sets belong to. */
  key: string | null
  /** Text conflicts seen unresolved in this round: once resolved, they are reviewable. */
  seen: ReadonlySet<string>
  reviewed: ReadonlySet<string>
  /** Resolved paths `mergeFile` could not open (controller rulings 6/7). */
  notReviewable: ReadonlySet<string>
  /** Chunk counts by path; null = not countable (binary / too large). Missing = not loaded. */
  counts: ReadonlyMap<string, ChunkCount | null>
}

export interface ConflictStore {
  getState(): ConflictStoreState
  subscribe(listener: () => void): () => void
  /** Reload operationState; an older response arriving late is dropped. */
  refresh(): Promise<void>
  /** No operation any more: drop the value (and the origin). */
  clear(): void
  /** T2: conflicts without an operation now come from `origin` (kept across refreshes until clear). */
  noteOrigin(origin: ConflictOrigin): void
  getReview(): ConflictReview
  markReviewed(path: string): void
  /** 「全部简单冲突」 resolved these files without anyone looking: not reviewed. */
  unmarkReviewed(paths: readonly string[]): void
  markNotReviewable(path: string): void
  /** Loads the missing chunk counts (first {@link CHUNK_COUNT_LIMIT} unresolved text conflicts), one file at a time. */
  loadCounts(): Promise<void>
  /** The file changed (window left, resolved, restored): its count is loaded again. */
  invalidateCount(path: string): void
}

/** At most this many unresolved files get a chunk count (design §10.2 P1, decision D4). */
export const CHUNK_COUNT_LIMIT = 50

/** Conflict kinds with both sides' text: they open in the three panes and have chunk counts. */
const TEXT_KINDS: ReadonlySet<ConflictKind> = new Set<ConflictKind>(['both-modified', 'both-added'])

export function isTextConflict(entry: FileEntry): boolean {
  return TEXT_KINDS.has(entry.conflict ?? 'both-modified')
}

/**
 * Key of one review round: the operation identity plus the rebase step (each step has its own
 * conflicts and resolve-undo); 'none' for the stash pop without an operation.
 */
export function reviewKey(value: OperationStateValue | null): string | null {
  if (value === null) return null
  const step = value.step === undefined ? '' : `#${value.step.current}`
  return `${operationIdentity(value) ?? 'none'}${step}`
}

const EMPTY_REVIEW: ConflictReview = { key: null, seen: new Set(), reviewed: new Set(), notReviewable: new Set(), counts: new Map() }

function countOf(file: MergeFileValue): ChunkCount | null {
  const texts = mergeTexts(file)
  if (texts === null) return null
  const model = (file.draft === null ? null : createModel(texts, file.draft)) ?? createModel(texts)
  return chunkCounts(model)
}

/** Cache key of a count: the three stage blobs and the draft (a draft changes the count). */
function countKey(file: MergeFileValue): string {
  return [file.base?.blob, file.ours?.blob, file.theirs?.blob, file.draft?.savedAt ?? '', file.tooLarge].join('|')
}

const IDLE: ConflictStoreState = { status: 'idle', value: null, error: null }

export function createConflictStore(deps: ConflictStoreDeps): ConflictStore {
  const listeners = new Set<() => void>()
  let state = IDLE
  let seq = 0
  let review = EMPTY_REVIEW
  /** Counts by stages (decision D4: the same diff3 as the window); survives invalidation of the path. */
  const countCache = new Map<string, { key: string; count: ChunkCount | null }>()
  /**
   * T2: paths whose `mergeFile` failed in this round. A failure has no stages to key by, so it lasts
   * as long as the stages can only be the same: until the round changes (new operation / rebase
   * step), the path is invalidated (window left, resolved, restored) or the list is cleared.
   */
  const failedCounts = new Set<string>()
  let counting: Promise<void> | null = null
  let countAgain = false

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const emit = (next: ConflictStoreState): void => {
    state = next
    notify()
  }
  const setReview = (patch: Partial<ConflictReview>): void => {
    review = { ...review, ...patch }
    notify()
  }

  /** A new review round clears everything; then the unresolved text conflicts are remembered as seen. */
  const syncReview = (value: OperationStateValue): void => {
    const key = reviewKey(value)
    let next = review
    if (key !== review.key) {
      next = { ...EMPTY_REVIEW, key }
      countCache.clear()
      failedCounts.clear()
    }
    const fresh = value.conflicts.filter(entry => isTextConflict(entry) && !next.seen.has(entry.path))
    if (fresh.length > 0) next = { ...next, seen: new Set([...next.seen, ...fresh.map(entry => entry.path)]) }
    if (next !== review) {
      review = next
    }
  }

  const countPass = async (): Promise<void> => {
    const load = deps.loadFile
    if (load === undefined) return
    const key = review.key
    const targets = (state.value?.conflicts ?? []).filter(isTextConflict).slice(0, CHUNK_COUNT_LIMIT)
    for (const entry of targets) {
      if (review.key !== key) return
      if (review.counts.has(entry.path) || failedCounts.has(entry.path)) continue
      let result: RpcResult<MergeFileValue>
      try {
        result = await load(entry.path)
      } catch {
        result = { ok: false, error: { code: 'git/exec-failed', message: 'mergeFile threw' } }
      }
      if (review.key !== key) return
      if (!result.ok) {
        failedCounts.add(entry.path)
        continue
      }
      const file = result.value
      const cacheKey = countKey(file)
      const cached = countCache.get(entry.path)
      const count = cached !== undefined && cached.key === cacheKey ? cached.count : countOf(file)
      countCache.set(entry.path, { key: cacheKey, count })
      setReview({ counts: new Map([...review.counts, [entry.path, count]]) })
    }
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
      if (result.ok) syncReview(result.value)
      const origin = state.origin === undefined ? {} : { origin: state.origin }
      emit(result.ok
        ? { status: 'ready', value: result.value, error: null, ...origin }
        : { status: 'error', value: state.value, error: result.error, ...origin })
    },
    noteOrigin: (origin) => {
      if ((state.origin ?? 'stash') !== origin) emit({ ...state, origin })
    },
    clear: () => {
      seq += 1
      review = EMPTY_REVIEW
      countCache.clear()
      failedCounts.clear()
      if (state !== IDLE) emit(IDLE)
    },
    getReview: () => review,
    markReviewed: (path) => {
      if (!review.reviewed.has(path)) setReview({ reviewed: new Set([...review.reviewed, path]) })
    },
    unmarkReviewed: (paths) => {
      if (!paths.some(path => review.reviewed.has(path))) return
      const reviewed = new Set(review.reviewed)
      for (const path of paths) reviewed.delete(path)
      setReview({ reviewed })
    },
    markNotReviewable: (path) => {
      if (!review.notReviewable.has(path)) setReview({ notReviewable: new Set([...review.notReviewable, path]) })
    },
    loadCounts: async () => {
      if (counting !== null) {
        countAgain = true
        return await counting
      }
      counting = (async () => {
        do {
          countAgain = false
          await countPass()
        } while (countAgain)
      })()
      try {
        await counting
      } finally {
        counting = null
      }
    },
    invalidateCount: (path) => {
      failedCounts.delete(path)
      if (!review.counts.has(path)) return
      const next = new Map(review.counts)
      next.delete(path)
      setReview({ counts: next })
    },
  }
}

export function useConflictState(store: ConflictStore): ConflictStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export function useConflictReview(store: ConflictStore): ConflictReview {
  return useSyncExternalStore(store.subscribe, store.getReview, store.getReview)
}

// ---------------------------------------------------------------------------
// Review Changes (confirmation 2): bottom button, queue and row selection
// ---------------------------------------------------------------------------

/** Paths the bottom button works on: unresolved files, and resolved files that may be reviewed. */
export interface ReviewGroups {
  unresolved: readonly string[]
  /** Resolved paths except those `mergeFile` could not open. */
  resolved: readonly string[]
}

/**
 * Groups and the effective reviewed set: resolved files never seen unresolved in this round (opened
 * before a page reload, or auto-merged and never conflicting) count as reviewed (decision D5).
 */
export function reviewInputs(value: OperationStateValue | null, review: ConflictReview): { groups: ReviewGroups; reviewed: ReadonlySet<string> } {
  const groups = conflictGroups(value)
  const resolved = groups.resolved.filter(path => !review.notReviewable.has(path))
  const reviewed = new Set(review.reviewed)
  for (const path of resolved) if (!review.seen.has(path)) reviewed.add(path)
  return { groups: { unresolved: groups.unresolved.map(entry => entry.path), resolved }, reviewed }
}

export type ManualButtonLabel = 'resolveManually' | 'reviewChanges'

/**
 * The bottom button (confirmation 2): 「逐个解决」 while a selected file — or, without a selection,
 * any file — is unresolved; 「审查更改」 when what is left is resolved but not reviewed; hidden (null)
 * when everything is resolved and reviewed (「接受并完成」 is then the primary button).
 */
export function manualButton(groups: ReviewGroups, selected: ReadonlySet<string>, reviewed: ReadonlySet<string>): { label: ManualButtonLabel } | null {
  const selectedUnresolved = groups.unresolved.some(path => selected.has(path))
  const selectedAny = selectedUnresolved || groups.resolved.some(path => selected.has(path))
  if (selectedUnresolved || (!selectedAny && groups.unresolved.length > 0)) return { label: 'resolveManually' }
  if (groups.resolved.some(path => !reviewed.has(path))) return { label: 'reviewChanges' }
  if (groups.unresolved.length > 0) return { label: 'resolveManually' }
  return null
}

/** Files the button opens one after another: selected (list order) → other unresolved → resolved unreviewed. */
export function reviewQueue(groups: ReviewGroups, selected: ReadonlySet<string>, reviewed: ReadonlySet<string>): string[] {
  const order = [...groups.unresolved, ...groups.resolved]
  const queue = new Set<string>(order.filter(path => selected.has(path)))
  for (const path of groups.unresolved) queue.add(path)
  for (const path of groups.resolved) if (!reviewed.has(path)) queue.add(path)
  return [...queue]
}

export interface RowSelection {
  selected: ReadonlySet<string>
  /** Where a Shift range starts (the last plain or toggling click). */
  anchor: string | null
}

/** Row click: plain = only this row; Cmd/Ctrl (`toggle`) = add / remove; Shift (`range`) = anchor … row in list order. */
export function nextSelection(order: readonly string[], current: RowSelection, path: string, mods: { toggle: boolean; range: boolean }): RowSelection {
  if (mods.range && current.anchor !== null && order.includes(current.anchor)) {
    const from = order.indexOf(current.anchor)
    const to = order.indexOf(path)
    if (to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      return { selected: new Set(order.slice(lo, hi + 1)), anchor: current.anchor }
    }
  }
  if (mods.toggle) {
    const selected = new Set(current.selected)
    if (selected.has(path)) selected.delete(path)
    else selected.add(path)
    return { selected, anchor: path }
  }
  return { selected: new Set([path]), anchor: path }
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
