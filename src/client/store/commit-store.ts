// Commit message + commit action (design §8.2.3/§8.2.4): draft/history persistence, the submit
// state machine (idle → submitting → success | failure), the enable/disable gate and error copy.
// React-free; the Host client and storage are injected.
import { useSyncExternalStore } from 'react'
import type {
  CommitResultValue,
  GitError,
  RebaseStop,
  RepoOperation,
  RpcResult,
  StatusValue,
  WritePolicyValue,
} from '../../shared/protocol.ts'
import { WRITE_PATHS_MAX } from '../../shared/protocol.ts'
import { newRequestId as defaultRequestId } from '../git-client.ts'
import type { GitClient } from '../git-client.ts'
import { READ_ONLY_REASON_KEY, OPERATION_KEY } from '../locales.ts'
import type { Translate } from '../localized-text.ts'
import type { ActionOutcome } from './action-store.ts'

export const HISTORY_LIMIT = 20
export const SUBJECT_SOFT_LIMIT = 72
export const MESSAGE_MIN_ROWS = 3
export const MESSAGE_MAX_ROWS = 8
const HOOK_DETAIL_MAX = 800

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The subset of `Storage` the store needs; every access is wrapped in try/catch. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** `localStorage` when accessible (private mode or blocked site data → null). */
export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage as Storage | undefined
    return storage ?? null
  } catch {
    return null
  }
}

export function draftKey(sessionId: string): string {
  return `dsh-git:draft:${sessionId}`
}

export function historyKey(repoRoot: string): string {
  return `dsh-git:history:${repoRoot}`
}

function safeGet(storage: StorageLike | null, key: string): string | null {
  if (storage === null) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(storage: StorageLike | null, key: string, value: string | null): void {
  if (storage === null) return
  try {
    if (value === null || value === '') storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // Storage full or blocked: the in-memory state still works.
  }
}

function parseHistory(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

/** Newest first, de-duplicated, capped at {@link HISTORY_LIMIT}. */
export function pushHistory(history: readonly string[], message: string): string[] {
  return [message, ...history.filter(item => item !== message)].slice(0, HISTORY_LIMIT)
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Textarea rows: 3 by default, growing with the content up to 8 (then it scrolls). */
export function messageRows(message: string): number {
  const lines = message.split('\n').length
  return Math.min(MESSAGE_MAX_ROWS, Math.max(MESSAGE_MIN_ROWS, lines))
}

/** Soft, non-blocking hint when the subject line exceeds 72 characters. */
export function subjectHint(message: string, t: Translate): string | null {
  const subject = message.split('\n', 1)[0] ?? ''
  const length = [...subject].length
  if (length <= SUBJECT_SOFT_LIMIT) return null
  return t('commit.subjectTooLong', { length, limit: SUBJECT_SOFT_LIMIT })
}

export interface ShortcutEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  isComposing?: boolean
}

/** Cmd/Ctrl+Enter (ignored during IME composition). */
export function isSubmitShortcut(event: ShortcutEventLike): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.isComposing !== true
}

/** Message sent to the Host: trailing whitespace removed. */
export function normalizeMessage(message: string): string {
  return message.replace(/\s+$/u, '')
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type CommitPhase = 'idle' | 'submitting' | 'success' | 'failure'

export type CommitMode = 'files' | 'amend-message'

export interface CommitGateInput {
  writePolicy: WritePolicyValue
  status: StatusValue | null
  /** `BootstrapValue.pendingWrites`. */
  pendingWrites: number
  checkedCount: number
  message: string
  amend: boolean
  phase: CommitPhase
}

export interface CommitGate {
  mode: CommitMode
  submitLabel: string
  /** Every write control is disabled (read-only, operation, pending writes, no status). */
  blocked: boolean
  /** Why submit is disabled; null when it is enabled or merely loading. */
  disabledReason: string | null
  submitting: boolean
  canSubmit: boolean
  /** "Commit and push" allowed (not for amend, which would need a force push). */
  canPush: boolean
  /** No upstream or detached HEAD: pushing must go through the Push page. */
  pushNeedsPage: boolean
  rewriteWarning: string | null
  detachedHint: string | null
}

/**
 * TD-9: a write request carries at most {@link WRITE_PATHS_MAX} paths (the Host rejects more).
 * @returns the disabled reason when `count` exceeds the limit, otherwise null.
 */
export function writePathsLimitReason(count: number, t: Translate): string | null {
  return count > WRITE_PATHS_MAX ? t('write.tooManyPaths', { max: WRITE_PATHS_MAX, count }) : null
}

/** Read-only policy, no repository or pending writes (shared by the normal and operation gates). */
function writeBlockReason(input: Pick<CommitGateInput, 'writePolicy' | 'status' | 'pendingWrites'>, t: Translate): string | null {
  if (input.writePolicy.mode === 'read-only') {
    const code = input.writePolicy.reasonCode
    return code === undefined ? (input.writePolicy.reason ?? t('commit.reasonReadOnly')) : t(READ_ONLY_REASON_KEY[code])
  }
  if (input.status === null) return t('commit.reasonNoRepository')
  if (input.pendingWrites > 0) return t('commit.reasonPending')
  return null
}

/**
 * Decides what the commit controls show and whether they are enabled.
 * @param input - write policy, status snapshot, pending writes and the form state.
 * @param t - translator for labels and reasons.
 * @returns labels, the disabled reason and warnings.
 */
export function commitGate(input: CommitGateInput, t: Translate): CommitGate {
  const { status, amend } = input
  const mode: CommitMode = amend && input.checkedCount === 0 ? 'amend-message' : 'files'
  const submitLabel = !amend ? t('commit.submit') : mode === 'amend-message' ? t('commit.submitAmendMessage') : t('commit.submitAmend')
  let blockReason = writeBlockReason(input, t)
  if (blockReason === null && status !== null && status.operation !== null && !(status.operation === 'rebase' && status.rebaseStop === 'edit')) {
    blockReason = t('commit.reasonOperation', { operation: t(OPERATION_KEY[status.operation]) })
  }
  const blocked = blockReason !== null
  const submitting = input.phase === 'submitting'
  let disabledReason = blockReason
  if (disabledReason === null && !submitting) {
    if (normalizeMessage(input.message).trim() === '') disabledReason = t('commit.reasonNoMessage')
    else if (mode === 'files' && input.checkedCount === 0) disabledReason = t('commit.reasonNoFiles')
    else if (mode === 'files') disabledReason = writePathsLimitReason(input.checkedCount, t)
  }
  const canSubmit = disabledReason === null && !submitting
  const pushed = status !== null && status.upstream !== null && status.ahead === 0
  return {
    mode,
    submitLabel,
    blocked,
    disabledReason,
    submitting,
    canSubmit,
    canPush: canSubmit && !amend,
    pushNeedsPage: status === null || status.upstream === null || status.detached,
    rewriteWarning: amend && pushed ? t('commit.rewriteWarning') : null,
    detachedHint: status?.detached === true ? t('commit.detachedHint') : null,
  }
}

// ---------------------------------------------------------------------------
// Operation state commit (design §8.2.4, plan A3 T9)
// ---------------------------------------------------------------------------

/**
 * Shape of the commit page: `normal` (A2), `merge` (MERGE_HEAD: commit the merge, message from
 * MERGE_MSG), `sequencer` (cherry-pick / revert: continue), `rebase` (continue from the banner).
 */
export type CommitPageMode = 'normal' | 'merge' | 'sequencer' | 'rebase'

export function commitPageModeOf(operation: RepoOperation, rebaseStop?: RebaseStop): CommitPageMode {
  // B3a: stopped at an `edit`, the user commits / amends as usual; Continue stays in the banner.
  if (operation === 'rebase' && rebaseStop === 'edit') return 'normal'
  switch (operation) {
    case 'merge':
      return 'merge'
    case 'cherry-pick':
    case 'revert':
      return 'sequencer'
    case 'rebase':
      return 'rebase'
    default:
      return 'normal'
  }
}

export interface OperationGateInput extends Pick<CommitGateInput, 'writePolicy' | 'status' | 'pendingWrites' | 'message' | 'phase'> {
  mode: Exclude<CommitPageMode, 'normal'>
}

export interface OperationGate {
  title: string
  submitLabel: string
  disabledReason: string | null
  /** Read-only, no repository or pending writes: the message box is disabled too. */
  blocked: boolean
  /** Unresolved conflicts left (the page offers the conflict list). */
  conflicts: number
  submitting: boolean
  canSubmit: boolean
  /** Merge only: the message box is shown (prefilled with MERGE_MSG). */
  showMessage: boolean
  explanation: string
}

/** Controls of the commit page while a merge / cherry-pick / revert / rebase is in progress. */
export function operationGate(input: OperationGateInput, t: Translate): OperationGate {
  const conflicts = input.status?.conflicts.length ?? 0
  const sequencer = input.status?.operation === 'revert' ? 'revert' : 'cherry-pick'
  const submitting = input.phase === 'submitting'
  const blockReason = writeBlockReason(input, t)
  let disabledReason = blockReason
  if (disabledReason === null && conflicts > 0) disabledReason = t('commit.op.reasonConflicts', { count: conflicts })
  if (disabledReason === null && input.mode === 'merge' && normalizeMessage(input.message).trim() === '') disabledReason = t('commit.reasonNoMessage')
  const view = input.mode === 'merge'
    ? { title: t('commit.op.mergeTitle'), submitLabel: t('commit.op.submitMerge'), explanation: t('commit.op.mergeHint') }
    : input.mode === 'sequencer'
      ? { title: t(`commit.op.sequencerTitle.${sequencer}`), submitLabel: t(`commit.op.continue.${sequencer}`), explanation: t('commit.op.sequencerHint') }
      : { title: t('commit.op.rebaseTitle'), submitLabel: t('commit.op.continueRebase'), explanation: t('commit.op.rebaseHint') }
  return {
    ...view,
    disabledReason,
    blocked: blockReason !== null,
    conflicts,
    submitting,
    canSubmit: disabledReason === null && !submitting,
    showMessage: input.mode === 'merge',
  }
}

/** The message the commit page shows: the merge message in merge mode, else the draft. */
export function visibleMessage(state: CommitStoreState): string {
  return state.mode === 'merge' ? state.operationMessage : state.message
}

// ---------------------------------------------------------------------------
// Error copy
// ---------------------------------------------------------------------------

export interface CommitErrorView {
  title: string
  detail: string | null
  /** Suggested follow-up: open the Git console, or refresh the status and retry. */
  action: 'console' | 'refresh' | null
}

function hookOutput(details: Record<string, unknown> | undefined): string | null {
  if (details === undefined) return null
  const parts = ['summary', 'output', 'stderr', 'stdout']
    .map(key => details[key])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(value => value.trim())
  if (parts.length === 0) return null
  const text = [...new Set(parts)].join('\n')
  return text.length > HOOK_DETAIL_MAX ? `${text.slice(0, HOOK_DETAIL_MAX)}…` : text
}

/** Actionable copy for a failed commit (design §8.2.4, plan T5). */
export function commitErrorView(error: GitError, t: Translate): CommitErrorView {
  switch (error.code) {
    case 'git/hook-failed':
      return { title: t('commit.errorHook'), detail: hookOutput(error.details) ?? error.message, action: 'console' }
    case 'git/paths-changed':
      return { title: t('commit.errorPathsChanged'), detail: null, action: 'refresh' }
    case 'git/index-not-clean':
      return { title: t('commit.errorIndexNotClean'), detail: null, action: null }
    case 'git/sandbox-denied':
      return { title: t('commit.errorSandbox'), detail: error.message, action: null }
    case 'git/locked':
      return { title: t('commit.errorLocked'), detail: null, action: 'console' }
    case 'git/operation-in-progress':
      return { title: t('commit.errorOperation'), detail: null, action: 'refresh' }
    case 'git/timeout':
      return { title: t('commit.errorTimeout'), detail: null, action: 'console' }
    default:
      return { title: t('commit.errorGeneric'), detail: t('error.detail', { code: error.code, message: error.message }), action: 'console' }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CommitStoreState {
  message: string
  amend: boolean
  phase: CommitPhase
  error: GitError | null
  /** Latest successful commit ("已提交 7f3a2c1"); kept until the next success. */
  lastCommit: CommitResultValue | null
  history: string[]
  /** Page shape for the in-progress operation (A3 T9); set by the workbench from the status. */
  mode: CommitPageMode
  /** Merge mode message (MERGE_MSG prefill or the user's edit); the normal draft stays apart. */
  operationMessage: string
  /** The user edited {@link operationMessage}: a later prefill never overwrites it. */
  operationEdited: boolean
  /** Identity of the operation the message belongs to. */
  operationKey: string | null
}

export type CommitOutcome =
  | { ok: true; value: CommitResultValue; mode: CommitMode; paths: string[] }
  | { ok: false; error: GitError }
  /** Nothing was sent: empty message, or no files without amend. */
  | { ok: false; skipped: true }

export interface CommitStoreDeps {
  sessionId: string
  repoRoot: string
  client: Pick<GitClient, 'commitFiles' | 'amendMessage'>
  /** Defaults to {@link browserStorage}; null disables persistence. */
  storage?: StorageLike | null
  /** Defaults to `newRequestId` from git-client. */
  newRequestId?: () => string
}

export interface CommitStore {
  getState(): CommitStoreState
  subscribe(listener: () => void): () => void
  setMessage(message: string): void
  setAmend(amend: boolean): void
  /** Picks a history entry (replaces the message). */
  applyHistory(message: string): void
  /**
   * Commits the given paths (or amends the message when amend is on and paths is empty).
   * A second call while one is in flight returns the same promise.
   */
  submit(paths: readonly string[]): Promise<CommitOutcome>
  /** Clears success/failure feedback (back to idle). */
  dismiss(): void
  /**
   * Follow the repository operation: page mode, and in merge mode the MERGE_MSG prefill (never
   * over a user edit of the same operation; `key` identifies the operation).
   */
  setOperation(input: { mode: CommitPageMode; message?: string | undefined; key?: string | null | undefined }): void
  /**
   * Run the operation step (merge commit / continue) through the action store, with the same
   * phase feedback as a commit. A second call while one is in flight returns the same promise.
   */
  runOperation<V>(task: () => Promise<ActionOutcome<V>>): Promise<ActionOutcome<V>>
}

/** Transport-level failures where the Host may or may not have run the commit. */
function isUncertainFailure(error: GitError): boolean {
  return error.code === 'git/exec-failed' && error.details === undefined
}

export function createCommitStore(deps: CommitStoreDeps): CommitStore {
  const storage = deps.storage === undefined ? browserStorage() : deps.storage
  const nextRequestId = deps.newRequestId ?? defaultRequestId
  const listeners = new Set<() => void>()
  let state: CommitStoreState = {
    message: safeGet(storage, draftKey(deps.sessionId)) ?? '',
    amend: false,
    phase: 'idle',
    error: null,
    lastCommit: null,
    history: parseHistory(safeGet(storage, historyKey(deps.repoRoot))),
    mode: 'normal',
    operationMessage: '',
    operationEdited: false,
    operationKey: null,
  }
  let inflight: Promise<CommitOutcome> | null = null
  let operationInflight: Promise<ActionOutcome<unknown>> | null = null
  /** Request id of the last uncertain failure, reused when the same payload is retried. */
  let retry: { fingerprint: string; requestId: string } | null = null

  const emit = (patch: Partial<CommitStoreState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const setMessage = (message: string): void => {
    const settled = state.phase === 'success' || state.phase === 'failure'
    const feedback: Partial<CommitStoreState> = settled ? { phase: 'idle', error: null } : {}
    if (state.mode === 'merge') {
      emit({ ...feedback, operationMessage: message, operationEdited: true })
      return
    }
    safeSet(storage, draftKey(deps.sessionId), message)
    emit({ ...feedback, message })
  }

  const setOperation: CommitStore['setOperation'] = ({ mode, message, key = null }) => {
    if (mode === 'normal') {
      if (state.mode !== 'normal' || state.operationKey !== null) emit({ mode, operationMessage: '', operationEdited: false, operationKey: null })
      return
    }
    const sameOperation = key === state.operationKey && mode === state.mode
    // Carry 9: the status announced the mode before operationState loaded (key null); the first
    // key belongs to that same operation, so an early edit survives the MERGE_MSG prefill.
    const adopting = state.operationKey === null && key !== null && mode === state.mode
    const edited = (sameOperation || adopting) && state.operationEdited
    const operationMessage = edited ? state.operationMessage : (message ?? (sameOperation ? state.operationMessage : ''))
    if (sameOperation && operationMessage === state.operationMessage) return
    emit({ mode, operationKey: key, operationEdited: edited, operationMessage })
  }

  const finishOperation = <V>(outcome: ActionOutcome<V>): ActionOutcome<V> => {
    switch (outcome.kind) {
      case 'done': {
        const value = (outcome.value ?? {}) as Partial<CommitResultValue> & { head?: unknown }
        const sha = typeof value.sha === 'string' ? value.sha : typeof value.head === 'string' ? value.head : null
        const lastCommit = sha === null ? state.lastCommit : { sha, shortSha: typeof value.shortSha === 'string' ? value.shortSha : sha.slice(0, 7) }
        if (state.mode === 'merge') {
          const history = pushHistory(state.history, normalizeMessage(state.operationMessage))
          safeSet(storage, historyKey(deps.repoRoot), JSON.stringify(history))
          emit({ phase: 'success', error: null, lastCommit, history, operationMessage: '', operationEdited: false })
        } else {
          emit({ phase: 'success', error: null, lastCommit })
        }
        break
      }
      case 'failed':
        emit({ phase: 'failure', error: outcome.error })
        break
      case 'conflict':
      case 'cancelled':
        emit({ phase: 'idle', error: null })
        break
    }
    return outcome
  }

  const run = async (paths: string[], message: string, amend: boolean): Promise<CommitOutcome> => {
    const mode: CommitMode = amend && paths.length === 0 ? 'amend-message' : 'files'
    const fingerprint = JSON.stringify([mode, paths, message, amend])
    const requestId = retry?.fingerprint === fingerprint ? retry.requestId : nextRequestId()
    emit({ phase: 'submitting', error: null })
    let result: RpcResult<CommitResultValue>
    if (mode === 'amend-message') {
      result = await deps.client.amendMessage({ sessionId: deps.sessionId, requestId, message })
    } else {
      result = await deps.client.commitFiles({
        sessionId: deps.sessionId,
        requestId,
        paths,
        message,
        ...(amend ? { amend: true } : {}),
      })
    }
    if (!result.ok) {
      retry = isUncertainFailure(result.error) ? { fingerprint, requestId } : null
      emit({ phase: 'failure', error: result.error })
      return { ok: false, error: result.error }
    }
    retry = null
    const history = pushHistory(state.history, message)
    safeSet(storage, draftKey(deps.sessionId), null)
    safeSet(storage, historyKey(deps.repoRoot), JSON.stringify(history))
    emit({ phase: 'success', error: null, message: '', amend: false, lastCommit: result.value, history })
    return { ok: true, value: result.value, mode, paths }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setMessage,
    setAmend: amend => emit({ amend }),
    applyHistory: message => setMessage(message),
    submit(paths) {
      if (inflight !== null) return inflight
      const message = normalizeMessage(state.message)
      const list = [...paths]
      if (message.trim() === '' || (list.length === 0 && !state.amend)) return Promise.resolve({ ok: false, skipped: true })
      inflight = run(list, message, state.amend).finally(() => { inflight = null })
      return inflight
    },
    dismiss: () => emit({ phase: 'idle', error: null }),
    setOperation,
    runOperation<V>(task: () => Promise<ActionOutcome<V>>): Promise<ActionOutcome<V>> {
      if (operationInflight !== null) return operationInflight as Promise<ActionOutcome<V>>
      emit({ phase: 'submitting', error: null })
      const promise = task()
        .catch((error: unknown): ActionOutcome<V> => {
          const gitError: GitError = { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) }
          return { kind: 'failed', error: gitError, message: { key: 'action.error.fallback', params: { code: gitError.code, message: gitError.message } } }
        })
        .then(finishOperation)
        .finally(() => { operationInflight = null })
      operationInflight = promise as Promise<ActionOutcome<unknown>>
      return promise
    },
  }
}

/** Subscribes a component to the commit store. */
export function useCommitState(store: CommitStore): CommitStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
