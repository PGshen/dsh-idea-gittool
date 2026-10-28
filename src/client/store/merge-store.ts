// B1 T5 merge store: wires the pure merge model (src/client/merge), the four merge RPCs and the
// merge-window lifecycle. React-free; the workbench creates one store per session.
// - open(path) loads the three versions (+ draft); a response that is no longer current is dropped.
// - Binary / too large / delete-kind files load with `model: null` (the window shows the two-choice fallback).
// - dispatch() runs model actions (undoable), edit() maps user edits from the Result editor;
//   model-driven changes never go through `applyEdit`.
// - Writes (draft save, apply, unresolve) go through the ActionStore; read-only mode is rejected here first.
import { useSyncExternalStore } from 'react'
import type { GitError, MergeFileValue, MergeStageShas, RpcResult } from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import {
  acceptFile,
  acceptSide,
  appendBoth,
  applyEdit,
  applyNonConflicting,
  createModel,
  ignore,
  resolveSimple,
  resolveWhole,
  revert,
  toDraft,
} from '../merge/merge-model.ts'
import type { MergeModel, MergeSideName, MergeTexts } from '../merge/merge-model.ts'
import { resolvedReplay } from '../merge/resolved-replay.ts'
import type { ActionStore } from './action-store.ts'

export type MergeStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'applying' | 'error'

export interface MergeStoreState {
  status: MergeStatus
  path: string | null
  file: MergeFileValue | null
  /** Null for binary / too large / delete-kind files (two-choice fallback) and while not loaded. */
  model: MergeModel | null
  /** The model differs from what was loaded or last saved. */
  dirty: boolean
  /** A saved draft existed but could not be used (stages changed or chunks mismatch). */
  draftDiscarded: boolean
  /** Resolved file: the restored draft differs from the worktree; applying writes the draft (ruling 20). */
  draftDiffers: boolean
  error: LocalizedText | null
  canUndo: boolean
  canRedo: boolean
}

/** Model actions the window can dispatch (ids are chunk ids). */
export type MergeAction =
  | { type: 'accept'; id: number; side: MergeSideName }
  | { type: 'ignore'; id: number; side: MergeSideName }
  | { type: 'append'; id: number; order: 'left-first' | 'right-first' }
  | { type: 'resolveWhole'; id: number; side: MergeSideName }
  | { type: 'applyNonConflicting'; which: MergeSideName | 'all' }
  | { type: 'resolveSimple' }
  | { type: 'acceptFile'; side: MergeSideName }
  | { type: 'revert' }

export interface MergeStoreDeps {
  loadFile: (path: string, signal?: AbortSignal) => Promise<RpcResult<MergeFileValue>>
  /** Only `run` is used (mergeDraftSave / mergeApply / unresolveConflict). */
  actions: Pick<ActionStore, 'run'>
  /** Non-null in read-only mode: the reason shown instead of sending a write. */
  readOnlyReason?: () => LocalizedText | null
  /** B4a setting: apply the non-conflicting changes when a fresh (no draft, unresolved) file opens. */
  autoApplyNonConflicting?: () => boolean
  /** A file finished loading in the window (Review Changes marks it reviewed). */
  onOpened?: (path: string) => void
  /**
   * Loading failed: the `mergeFile` error, or null for a resolved file the window cannot review (no
   * readable worktree text, or binary / too large: there is nothing left to choose for it).
   */
  onLoadFailed?: (path: string, error: GitError | null) => void
  /** `mergeApply` succeeded (refresh the conflict list, advance the Review Changes queue). */
  onApplied?: (path: string, remaining: number) => void
}

export interface MergeStore {
  getState(): MergeStoreState
  subscribe(listener: () => void): () => void
  open(path: string): Promise<void>
  /** Runs a model action; returns the number of chunks `resolveSimple` resolved (0 for other actions). */
  dispatch(action: MergeAction): number
  /** A user edit of the Result editor (character offsets, as CodeMirror reports them). */
  edit(from: number, to: number, insert: string): void
  undo(): boolean
  redo(): boolean
  /** Saves the draft (when dirty) so the window can close; false when it must stay open. */
  saveAndClose(): Promise<boolean>
  /** Writes the Result back and marks the file resolved; null when it did not happen (see `error`). */
  apply(): Promise<{ remaining: number } | null>
  /** Closes the window state without saving (a saved draft stays on the Host). */
  discard(): void
  /** "Restore conflict resolution" for a resolved file (works without an open window). */
  unresolve(path: string): Promise<{ remaining: number } | { error: LocalizedText }>
}

const IDLE: MergeStoreState = {
  status: 'idle',
  path: null,
  file: null,
  model: null,
  dirty: false,
  draftDiscarded: false,
  draftDiffers: false,
  error: null,
  canUndo: false,
  canRedo: false,
}

function thrownError(error: unknown): GitError {
  return { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) }
}

function stagesOf(file: MergeFileValue): MergeStageShas {
  return { base: file.base?.blob ?? null, ours: file.ours?.blob ?? null, theirs: file.theirs?.blob ?? null }
}

/** Texts of a plain text conflict; null when the window must fall back to two choices. */
export function mergeTexts(file: MergeFileValue): MergeTexts | null {
  // Symlinks and submodules are never merged as text, whatever the sides carry.
  if (file.special !== undefined && file.special !== null) return null
  if (file.tooLarge || file.ours === null || file.theirs === null) return null
  if (file.ours.text === null || file.theirs.text === null) return null
  if (file.base !== null && file.base.text === null) return null
  return { base: file.base?.text ?? null, ours: file.ours.text, theirs: file.theirs.text }
}

/** A stale-target failure with a reason (stages / worktree changed) means "reload the file". */
function failureText(error: GitError, fallback: LocalizedText): LocalizedText {
  const reason = error.details?.['reason']
  return error.code === 'git/stale-target' && typeof reason === 'string' ? text('merge.error.stale') : fallback
}

function runModelAction(model: MergeModel, action: MergeAction): { model: MergeModel; resolved: number } {
  switch (action.type) {
    case 'accept': return { model: acceptSide(model, action.id, action.side), resolved: 0 }
    case 'ignore': return { model: ignore(model, action.id, action.side), resolved: 0 }
    case 'append': return { model: appendBoth(model, action.id, action.order), resolved: 0 }
    case 'resolveWhole': return { model: resolveWhole(model, action.id, action.side), resolved: 0 }
    case 'applyNonConflicting': return { model: applyNonConflicting(model, action.which), resolved: 0 }
    case 'resolveSimple': return resolveSimple(model)
    case 'acceptFile': return { model: acceptFile(model, action.side), resolved: 0 }
    case 'revert': return { model: revert(model), resolved: 0 }
  }
}

export function createMergeStore(deps: MergeStoreDeps): MergeStore {
  const listeners = new Set<() => void>()
  let state = IDLE
  let seq = 0
  /** The model as loaded or last saved; `dirty` is "model !== baseline". */
  let baseline: MergeModel | null = null
  let past: MergeModel[] = []
  let future: MergeModel[] = []
  let lastWasEdit = false

  const emit = (next: MergeStoreState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }

  const withModel = (model: MergeModel | null, extra: Partial<MergeStoreState> = {}): MergeStoreState => ({
    ...state,
    ...extra,
    model,
    dirty: model !== null && model !== baseline,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  })

  function setModel(next: MergeModel, isEdit: boolean): void {
    const current = state.model
    if (current === null || next === current) return
    if (!(isEdit && lastWasEdit)) past.push(current)
    lastWasEdit = isEdit
    future = []
    emit(withModel(next, { error: null }))
  }

  function readOnlyBlock(): boolean {
    const reason = deps.readOnlyReason?.() ?? null
    if (reason === null) return false
    emit({ ...state, error: reason })
    return true
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    open: async (path) => {
      const mine = ++seq
      baseline = null
      past = []
      future = []
      lastWasEdit = false
      emit({ ...IDLE, status: 'loading', path })
      let result: RpcResult<MergeFileValue>
      try {
        result = await deps.loadFile(path)
      } catch (error) {
        result = { ok: false, error: thrownError(error) }
      }
      if (mine !== seq) return
      if (!result.ok) {
        emit({ ...IDLE, status: 'error', path, error: text('merge.error.loadFailed', { code: result.error.code }) })
        deps.onLoadFailed?.(path, result.error)
        return
      }
      const file = result.value
      const texts = mergeTexts(file)
      let model: MergeModel | null = null
      let draftDiscarded = file.draftStale
      let draftDiffers = false
      if (file.resolved) {
        // Ruling 16: the Result is the worktree text (ruling 20: a usable draft wins, with a notice);
        // without text sides or worktree text the resolved file is not reviewable (the Review queue skips it).
        const replay = texts === null ? null : resolvedReplay(texts, file.worktreeText, file.draft)
        if (replay === null) {
          emit({ ...IDLE, status: 'error', path, error: text('merge.error.worktreeUnreadable') })
          deps.onLoadFailed?.(path, null)
          return
        }
        model = replay.model
        draftDiffers = replay.draftDiffers
        draftDiscarded ||= replay.draftUnusable
      } else if (texts !== null) {
        if (file.draft !== null) {
          model = createModel(texts, file.draft)
          if (model === null) draftDiscarded = true
        }
        model ??= createModel(texts)
      }
      baseline = model
      emit({ ...IDLE, status: 'ready', path, file, model, draftDiscarded, draftDiffers })
      // Only a fresh start: a restored draft or a resolved file already holds the user's choices.
      if (model !== null && !file.resolved && file.draft === null && deps.autoApplyNonConflicting?.() === true) {
        setModel(applyNonConflicting(model, 'all'), false)
      }
      deps.onOpened?.(path)
    },

    dispatch: (action) => {
      const model = state.model
      if (model === null || state.status !== 'ready') return 0
      const { model: next, resolved } = runModelAction(model, action)
      setModel(next, false)
      return resolved
    },

    edit: (from, to, insert) => {
      const model = state.model
      if (model === null || state.status !== 'ready') return
      setModel(applyEdit(model, from, to, insert), true)
    },

    undo: () => {
      const previous = past.pop()
      if (previous === undefined || state.model === null) return false
      future.push(state.model)
      lastWasEdit = false
      emit(withModel(previous, { error: null }))
      return true
    },

    redo: () => {
      const next = future.pop()
      if (next === undefined || state.model === null) return false
      past.push(state.model)
      lastWasEdit = false
      emit(withModel(next, { error: null }))
      return true
    },

    saveAndClose: async () => {
      const { model, file, path } = state
      if (state.status !== 'ready' || model === null || file === null || path === null) return state.status === 'ready'
      if (!state.dirty) return true
      if (readOnlyBlock()) return false
      const mine = seq
      emit({ ...state, status: 'saving', error: null })
      const outcome = await deps.actions.run('mergeDraftSave', { path, draft: toDraft(model, stagesOf(file)) }, { target: path })
      if (mine !== seq) return false
      if (outcome.kind === 'done') {
        baseline = model
        emit(withModel(state.model, { status: 'ready' }))
        return true
      }
      emit({
        ...state,
        status: 'ready',
        error: outcome.kind === 'failed' ? failureText(outcome.error, outcome.message) : text('merge.error.stale'),
      })
      return false
    },

    apply: async () => {
      const { model, file, path } = state
      if (state.status !== 'ready' || model === null || file === null || path === null) return null
      if (readOnlyBlock()) return null
      const mine = seq
      emit({ ...state, status: 'applying', error: null })
      const outcome = await deps.actions.run('mergeApply', {
        path,
        result: model.result,
        stages: stagesOf(file),
        expectedWorktreeSha: file.worktreeSha,
      }, { target: path })
      if (mine !== seq) return null
      if (outcome.kind === 'done') {
        baseline = model
        emit(withModel(state.model, { status: 'ready' }))
        deps.onApplied?.(path, outcome.value.remaining)
        return { remaining: outcome.value.remaining }
      }
      emit({
        ...state,
        status: 'ready',
        error: outcome.kind === 'failed' ? failureText(outcome.error, outcome.message) : text('merge.error.stale'),
      })
      return null
    },

    discard: () => {
      seq += 1
      baseline = null
      past = []
      future = []
      lastWasEdit = false
      if (state !== IDLE) emit(IDLE)
    },

    unresolve: async (path) => {
      const reason = deps.readOnlyReason?.() ?? null
      if (reason !== null) return { error: reason }
      const outcome = await deps.actions.run('unresolveConflict', { path }, { target: path })
      if (outcome.kind === 'done') return { remaining: outcome.value.remaining }
      return { error: outcome.kind === 'failed' ? outcome.message : text('merge.error.stale') }
    },
  }
}

export function useMergeState(store: MergeStore): MergeStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
