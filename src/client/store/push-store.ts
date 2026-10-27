// Push / Push Rejected / Rollback flows (design §11, §8.2.5): React-free stores plus pure helpers.
// RPC is injected (a subset of GitClient); persistent memory goes through an injected storage
// object and every access is wrapped in try/catch. One requestId per user action; a repeated
// click while the action is running returns the same promise instead of a second RPC.
import { useSyncExternalStore } from 'react'
import type {
  CommitSummary,
  GitError,
  PushPreviewValue,
  PushRejectedDetails,
  PushRejectReason,
  PushValue,
  RollbackValue,
  RpcResult,
} from '../../shared/protocol.ts'
import { WRITE_PATHS_MAX } from '../../shared/protocol.ts'
import type { GitClient } from '../git-client.ts'
import { newRequestId as defaultRequestId } from '../git-client.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal storage surface (localStorage-compatible). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The browser localStorage, or null when unavailable / access throws. */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    return storage ?? null
  } catch {
    return null
  }
}

/**
 * Remember the focused element and return a function that restores focus to it (design §5.3:
 * closing an overlay returns focus to its trigger). No-op outside the browser.
 */
export function rememberFocus(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const active = document.activeElement
  return () => {
    if (active instanceof HTMLElement && active.isConnected) active.focus()
  }
}

function asError(error: unknown): GitError {
  return { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) }
}

async function settle<T>(call: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await call()
  } catch (error) {
    return { ok: false, error: asError(error) }
  }
}

interface Emitter<S> {
  get(): S
  set(next: S): void
  subscribe(listener: () => void): () => void
}

function createEmitter<S>(initial: S): Emitter<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next) => {
      state = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ---------------------------------------------------------------------------
// Push form defaults and memory
// ---------------------------------------------------------------------------

export const PUSH_MEMORY_PREFIX = 'dsh-git:push:'

/** Persisted per repository; never contains the risk confirmation or force flag. */
export interface PushMemory {
  remote: string
  branch: string
  /** Local branch the memory was recorded on; the remote branch is only reused for the same one. */
  localBranch: string | null
}

export interface PushForm {
  remote: string
  /** Remote branch name (no `refs/heads/`). */
  branch: string
  setUpstream: boolean
  forceWithLease: boolean
  /** Risk confirmation for force-with-lease; never remembered. */
  riskConfirmed: boolean
  tags: boolean
}

const EMPTY_FORM: PushForm = {
  remote: '',
  branch: '',
  setUpstream: false,
  forceWithLease: false,
  riskConfirmed: false,
  tags: false,
}

/** Split `origin/feat/x` into remote + branch using the longest matching remote name. */
export function splitUpstream(upstream: string, remotes: readonly string[]): { remote: string; branch: string } | null {
  let best: string | undefined
  for (const remote of remotes) {
    if (upstream.startsWith(`${remote}/`) && (best === undefined || remote.length > best.length)) best = remote
  }
  if (best === undefined) return null
  return { remote: best, branch: upstream.slice(best.length + 1) }
}

/**
 * Push page defaults (design §11): the current upstream when there is one; otherwise the
 * remembered choice for this local branch, else the default remote and the same branch name.
 * Detached HEAD never pre-fills a remote branch: the user must type it explicitly.
 */
export function defaultPushForm(preview: PushPreviewValue, memory: PushMemory | null): PushForm {
  const { remotes } = preview
  const rememberedRemote = memory !== null && remotes.includes(memory.remote) ? memory.remote : null
  const fallbackRemote = rememberedRemote
    ?? (preview.defaultRemote !== null && remotes.includes(preview.defaultRemote) ? preview.defaultRemote : null)
    ?? remotes[0]
    ?? ''

  if (preview.detached || preview.branch === null) {
    return { ...EMPTY_FORM, remote: fallbackRemote }
  }
  const upstream = preview.upstream === null ? null : splitUpstream(preview.upstream, remotes)
  if (upstream !== null) return { ...EMPTY_FORM, remote: upstream.remote, branch: upstream.branch }

  const sameLocal = memory !== null && memory.localBranch === preview.branch && memory.branch.trim() !== ''
  return {
    ...EMPTY_FORM,
    remote: fallbackRemote,
    branch: sameLocal ? memory.branch : preview.branch,
    setUpstream: true,
  }
}

function readMemory(storage: KeyValueStorage | null, repoRoot: string): PushMemory | null {
  if (storage === null) return null
  try {
    const raw = storage.getItem(PUSH_MEMORY_PREFIX + repoRoot)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { remote, branch, localBranch } = parsed as Record<string, unknown>
    if (typeof remote !== 'string' || typeof branch !== 'string') return null
    return { remote, branch, localBranch: typeof localBranch === 'string' ? localBranch : null }
  } catch {
    return null
  }
}

function writeMemory(storage: KeyValueStorage | null, repoRoot: string, memory: PushMemory): void {
  if (storage === null) return
  try {
    storage.setItem(PUSH_MEMORY_PREFIX + repoRoot, JSON.stringify(memory))
  } catch {
    // Storage full or blocked: memory is a convenience only.
  }
}

// ---------------------------------------------------------------------------
// Rejection helpers
// ---------------------------------------------------------------------------

const REJECT_REASONS: readonly PushRejectReason[] = [
  'non-fast-forward',
  'fetch-first',
  'stale-lease',
  'protected',
  'hook-declined',
  'other',
]

export type RejectChoice = 'rebase' | 'merge' | 'force'

/** Choices on the Push Rejected page; protected branches never get force-with-lease. */
export function rejectChoicesFor(reason: PushRejectReason): RejectChoice[] {
  return reason === 'protected' ? ['rebase', 'merge'] : ['rebase', 'merge', 'force']
}

function isCommitSummary(value: unknown): value is CommitSummary {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.sha === 'string' && typeof candidate.shortSha === 'string' && typeof candidate.subject === 'string'
}

/** Read `git/rejected` details defensively; malformed details degrade to reason `other`. */
export function parseRejectedDetails(error: GitError, target: { remote: string; branch: string }): PushRejectedDetails {
  const details = error.details ?? {}
  const reason = REJECT_REASONS.find(candidate => candidate === details.reason)
  if (reason === undefined) {
    return { reason: 'other', remote: target.remote, branch: target.branch, remoteCommits: [], summary: error.message }
  }
  return {
    reason,
    remote: typeof details.remote === 'string' ? details.remote : target.remote,
    branch: typeof details.branch === 'string' ? details.branch : target.branch,
    remoteCommits: Array.isArray(details.remoteCommits) ? details.remoteCommits.filter(isCommitSummary) : [],
    summary: typeof details.summary === 'string' ? details.summary : error.message,
    // TD-10: only a full hex sha is echoed back as `expectedRemoteSha`; anything else is dropped.
    ...(typeof details.remoteSha === 'string' && FULL_SHA.test(details.remoteSha) ? { remoteSha: details.remoteSha } : {}),
  }
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** `details.command` of `git/auth-required`, when present. */
export function authCommandOf(error: GitError | null): string | null {
  if (error === null || error.code !== 'git/auth-required') return null
  const command = error.details?.command
  return typeof command === 'string' && command.trim() !== '' ? command : null
}

// ---------------------------------------------------------------------------
// Push store
// ---------------------------------------------------------------------------

export type PushClient = Pick<GitClient, 'pushPreview' | 'push' | 'pullForPush'>

export type PushView = 'push' | 'rejected'
export type PushBusy = 'push' | 'pull' | 'retry' | null

export interface PushState {
  view: PushView
  previewStatus: 'idle' | 'loading' | 'ready' | 'error'
  preview: PushPreviewValue | null
  previewError: GitError | null
  form: PushForm
  busy: PushBusy
  /** Last failure that kept the overlay open (auth-required, locked, …). */
  error: GitError | null
  rejected: PushRejectedDetails | null
  /** The rejected view was reached from the push page (Esc goes back) rather than opened directly. */
  rejectedFromPush: boolean
  choice: RejectChoice
  choiceRiskConfirmed: boolean
  /** The single automatic retry after a successful pull was rejected again. */
  autoRetryRejected: boolean
  /** B3b "push up to here": the commit pushed instead of HEAD (never forced, no pull-and-retry). */
  revision: string | null
}

export type PushOutcome =
  | { kind: 'pushed'; value: PushValue }
  | { kind: 'rejected'; details: PushRejectedDetails }
  | { kind: 'conflict'; error: GitError }
  | { kind: 'failed'; error: GitError }
  | { kind: 'blocked' }

export type PushBlockReason = 'loading' | 'busy' | 'no-remote' | 'no-branch' | 'detached-branch' | 'risk-unconfirmed' | 'nothing-to-push'
export type RejectedBlockReason = 'busy' | 'risk-unconfirmed' | 'force-protected'

/** Why the push button is disabled (null = enabled). Read-only is decided by the caller. */
export function pushSubmitBlock(state: PushState): PushBlockReason | null {
  if (state.busy !== null) return 'busy'
  if (state.previewStatus !== 'ready' || state.preview === null) return 'loading'
  if (state.form.remote === '') return 'no-remote'
  if (state.form.branch.trim() === '') return state.preview.detached ? 'detached-branch' : 'no-branch'
  // B3b review I1: pushing an older commit than the remote has would only work by force.
  if (state.revision !== null && state.preview.commits.length === 0) return 'nothing-to-push'
  if (state.form.forceWithLease && !state.form.riskConfirmed) return 'risk-unconfirmed'
  return null
}

/** Why the Push Rejected primary action is disabled (null = enabled). */
export function rejectedSubmitBlock(state: PushState): RejectedBlockReason | null {
  if (state.busy !== null) return 'busy'
  if (state.choice === 'force') {
    if (state.rejected?.reason === 'protected') return 'force-protected'
    if (!state.choiceRiskConfirmed) return 'risk-unconfirmed'
  }
  return null
}

export type PushEscapeAction = 'ignore' | 'back' | 'close'

/** Esc goes back exactly one level (§5.3); ignored while a network write is running. */
export function pushEscapeAction(state: Pick<PushState, 'busy' | 'view' | 'rejectedFromPush'>): PushEscapeAction {
  if (state.busy !== null) return 'ignore'
  if (state.view === 'rejected' && state.rejectedFromPush) return 'back'
  return 'close'
}

export interface PushStore {
  getState(): PushState
  subscribe(listener: () => void): () => void
  /** Fetch `pushPreview` and fill the form defaults. */
  load(): Promise<void>
  updateForm(patch: Partial<PushForm>): void
  /** Push with the current form. */
  submit(): Promise<PushOutcome>
  setChoice(choice: RejectChoice): void
  setChoiceRiskConfirmed(confirmed: boolean): void
  /** Run the chosen rejection handling: pull (+ one automatic push retry) or force-with-lease. */
  resolveRejected(): Promise<PushOutcome>
  /** Leave the rejected view for the push form (Esc when reached from the push page). */
  backToPush(): void
  dispose(): void
}

export interface PushStoreOptions {
  client: PushClient
  sessionId: string
  /** Memory key: last remote/branch are remembered per repository. */
  repoRoot: string
  /** Defaults to none (tests); the UI passes `browserStorage()`. */
  storage?: KeyValueStorage | null
  newRequestId?: () => string
  /** Open directly on the rejected view (e.g. "commit and push" was rejected). */
  initialRejection?: PushRejectedDetails
  /** B3b "push up to here": push this commit instead of HEAD. */
  revision?: string
}

/**
 * Create the Push / Push Rejected store.
 * @param options - injected client subset, session, repository key, storage and id factory.
 * @returns A subscribable store.
 */
export function createPushStore(options: PushStoreOptions): PushStore {
  const storage = options.storage ?? null
  const makeId = options.newRequestId ?? defaultRequestId
  const initial = options.initialRejection
  const emitter = createEmitter<PushState>({
    view: initial === undefined ? 'push' : 'rejected',
    previewStatus: 'idle',
    preview: null,
    previewError: null,
    form: initial === undefined ? EMPTY_FORM : { ...EMPTY_FORM, remote: initial.remote, branch: initial.branch },
    busy: null,
    error: null,
    rejected: initial ?? null,
    rejectedFromPush: false,
    revision: options.revision ?? null,
    choice: 'rebase',
    choiceRiskConfirmed: false,
    autoRetryRejected: false,
  })
  const patch = (next: Partial<PushState>): void => { emitter.set({ ...emitter.get(), ...next }) }
  let previewController: AbortController | undefined
  let inflight: Promise<PushOutcome> | undefined
  let disposed = false

  const remember = (form: PushForm): void => {
    const preview = emitter.get().preview
    writeMemory(storage, options.repoRoot, {
      remote: form.remote,
      branch: form.branch.trim(),
      localBranch: preview?.branch ?? null,
    })
  }

  /** `expectedRemoteSha` (TD-10) only accompanies a force-with-lease; an old Host omits it. */
  const runPush = async (form: PushForm, force: boolean, expectedRemoteSha?: string): Promise<RpcResult<PushValue>> => {
    const target = { remote: form.remote, branch: form.branch.trim() }
    return settle(() => options.client.push({
      sessionId: options.sessionId,
      requestId: makeId(),
      ...target,
      setUpstream: form.setUpstream,
      forceWithLease: force,
      tags: form.tags,
      ...(force && expectedRemoteSha !== undefined ? { expectedRemoteSha } : {}),
      ...(options.revision === undefined ? {} : { revision: options.revision }),
    }))
  }

  /** Map a push result onto state + outcome (shared by submit, retry and force). */
  const finishPush = (result: RpcResult<PushValue>, form: PushForm, fromRetry: boolean): PushOutcome => {
    if (result.ok) {
      remember(form)
      patch({ busy: null, error: null })
      return { kind: 'pushed', value: result.value }
    }
    // B3b review I1/I2: a push up to a commit never goes to the pull / force choices.
    if (result.error.code === 'git/rejected' && options.revision !== undefined) {
      patch({ busy: null, error: result.error })
      return { kind: 'failed', error: result.error }
    }
    if (result.error.code === 'git/rejected') {
      const details = parseRejectedDetails(result.error, { remote: form.remote, branch: form.branch.trim() })
      const state = emitter.get()
      const enteringFromPush = state.view === 'push'
      patch({
        busy: null,
        error: null,
        view: 'rejected',
        rejected: details,
        rejectedFromPush: enteringFromPush ? true : state.rejectedFromPush,
        choice: 'rebase',
        choiceRiskConfirmed: false,
        autoRetryRejected: fromRetry,
      })
      return { kind: 'rejected', details }
    }
    patch({ busy: null, error: result.error })
    return { kind: 'failed', error: result.error }
  }

  const once = (action: () => Promise<PushOutcome>): Promise<PushOutcome> => {
    if (inflight !== undefined) return inflight
    const running = action().finally(() => { inflight = undefined })
    inflight = running
    return running
  }

  return {
    getState: emitter.get,
    subscribe: emitter.subscribe,

    load: async () => {
      previewController?.abort()
      const controller = new AbortController()
      previewController = controller
      patch({ previewStatus: 'loading', previewError: null })
      const result = await settle(() => options.revision === undefined
        ? options.client.pushPreview(options.sessionId, controller.signal)
        : options.client.pushPreview(options.sessionId, controller.signal, options.revision))
      if (disposed || controller.signal.aborted || previewController !== controller) return
      previewController = undefined
      if (!result.ok) {
        patch({ previewStatus: 'error', previewError: result.error })
        return
      }
      const state = emitter.get()
      // A direct rejection keeps its remote/branch; the push form gets defaults otherwise.
      const form = state.view === 'rejected' && !state.rejectedFromPush
        ? state.form
        : defaultPushForm(result.value, readMemory(storage, options.repoRoot))
      patch({ previewStatus: 'ready', preview: result.value, form })
    },

    updateForm: (next) => {
      const form = { ...emitter.get().form, ...next }
      if (!form.forceWithLease) form.riskConfirmed = false
      patch({ form })
    },

    submit: () => once(async () => {
      const state = emitter.get()
      if (pushSubmitBlock(state) !== null) return { kind: 'blocked' }
      const form = state.form
      patch({ busy: 'push', error: null })
      const result = await runPush(form, form.forceWithLease && options.revision === undefined)
      return finishPush(result, form, false)
    }),

    setChoice: (choice) => {
      const state = emitter.get()
      if (state.rejected !== null && !rejectChoicesFor(state.rejected.reason).includes(choice)) return
      patch({ choice, choiceRiskConfirmed: false })
    },

    setChoiceRiskConfirmed: (confirmed) => { patch({ choiceRiskConfirmed: confirmed }) },

    resolveRejected: () => once(async () => {
      const state = emitter.get()
      if (state.rejected === null || rejectedSubmitBlock(state) !== null) return { kind: 'blocked' }
      const form: PushForm = { ...state.form, remote: state.rejected.remote, branch: state.rejected.branch }

      if (state.choice === 'force') {
        patch({ busy: 'push', error: null })
        return finishPush(await runPush(form, true, state.rejected.remoteSha), form, false)
      }

      patch({ busy: 'pull', error: null })
      const pulled = await settle(() => options.client.pullForPush({
        sessionId: options.sessionId,
        requestId: makeId(),
        remote: form.remote,
        branch: form.branch,
        mode: state.choice === 'merge' ? 'merge' : 'rebase',
      }))
      if (!pulled.ok) {
        patch({ busy: null, error: pulled.error.code === 'git/conflict' ? null : pulled.error })
        if (pulled.error.code === 'git/conflict') return { kind: 'conflict', error: pulled.error }
        return { kind: 'failed', error: pulled.error }
      }
      // Exactly one automatic retry after a successful pull, never forced.
      patch({ busy: 'retry' })
      return finishPush(await runPush(form, false), form, true)
    }),

    backToPush: () => {
      patch({ view: 'push', rejected: null, error: null, choice: 'rebase', choiceRiskConfirmed: false, autoRetryRejected: false })
    },

    dispose: () => {
      disposed = true
      previewController?.abort()
      previewController = undefined
    },
  }
}

export function usePushState(store: PushStore): PushState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

// ---------------------------------------------------------------------------
// Rollback store
// ---------------------------------------------------------------------------

export interface RollbackTarget {
  path: string
  /** Untracked files can only be rolled back by deleting them (danger confirmation). */
  untracked: boolean
}

export type RollbackClient = Pick<GitClient, 'rollback'>

export interface RollbackState {
  /** The danger confirmation for deleting untracked files; never pre-ticked. */
  deleteConfirmed: boolean
  busy: boolean
  error: GitError | null
  result: RollbackValue | null
}

export type RollbackOutcome =
  | { kind: 'done'; value: RollbackValue }
  | { kind: 'failed'; error: GitError }
  | { kind: 'blocked' }

export interface RollbackCounts {
  total: number
  tracked: number
  untracked: number
}

export function rollbackCounts(targets: readonly RollbackTarget[]): RollbackCounts {
  const untracked = targets.filter(target => target.untracked).length
  return { total: targets.length, tracked: targets.length - untracked, untracked }
}

export type RollbackBlockReason = 'busy' | 'nothing' | 'too-many'

/**
 * Rollback is pointless when only untracked files are selected and deletion is not confirmed;
 * more than {@link WRITE_PATHS_MAX} paths would be refused by the Host (TD-9).
 */
export function rollbackSubmitBlock(targets: readonly RollbackTarget[], state: RollbackState): RollbackBlockReason | null {
  if (state.busy) return 'busy'
  if (targets.length > WRITE_PATHS_MAX) return 'too-many'
  const counts = rollbackCounts(targets)
  if (counts.tracked === 0 && !(counts.untracked > 0 && state.deleteConfirmed)) return 'nothing'
  return null
}

/** The untracked paths the confirmation listed; sent as `confirmedUntracked` (TD-8). */
export function confirmedUntrackedOf(targets: readonly RollbackTarget[]): string[] {
  return targets.filter(target => target.untracked).map(target => target.path)
}

export interface RollbackSkipped {
  /** Shown as untracked and not deleted because the danger tick was off. */
  declined: string[]
  /** Tracked when confirmed, untracked at execution: never deleted (TD-8). */
  becameUntracked: string[]
}

/** Split `RollbackValue.skipped` by what the confirmation showed. */
export function rollbackSkipped(targets: readonly RollbackTarget[], skipped: readonly string[]): RollbackSkipped {
  const shown = new Set(confirmedUntrackedOf(targets))
  return {
    declined: skipped.filter(path => shown.has(path)),
    becameUntracked: skipped.filter(path => !shown.has(path)),
  }
}

export function rollbackEscapeAction(state: Pick<RollbackState, 'busy'>): 'ignore' | 'close' {
  return state.busy ? 'ignore' : 'close'
}

export interface RollbackStore {
  getState(): RollbackState
  subscribe(listener: () => void): () => void
  setDeleteConfirmed(confirmed: boolean): void
  submit(): Promise<RollbackOutcome>
}

export interface RollbackStoreOptions {
  client: RollbackClient
  sessionId: string
  targets: readonly RollbackTarget[]
  newRequestId?: () => string
}

/**
 * Create the rollback sheet store. Nothing is sent until `submit()`; cancelling has no effect.
 * @param options - injected client subset, session, targets and id factory.
 * @returns A subscribable store.
 */
export function createRollbackStore(options: RollbackStoreOptions): RollbackStore {
  const makeId = options.newRequestId ?? defaultRequestId
  const emitter = createEmitter<RollbackState>({ deleteConfirmed: false, busy: false, error: null, result: null })
  const patch = (next: Partial<RollbackState>): void => { emitter.set({ ...emitter.get(), ...next }) }
  let inflight: Promise<RollbackOutcome> | undefined

  const run = async (): Promise<RollbackOutcome> => {
    const state = emitter.get()
    if (rollbackSubmitBlock(options.targets, state) !== null) return { kind: 'blocked' }
    patch({ busy: true, error: null })
    const deleteUntracked = state.deleteConfirmed && rollbackCounts(options.targets).untracked > 0
    const result = await settle(() => options.client.rollback({
      sessionId: options.sessionId,
      requestId: makeId(),
      paths: options.targets.map(target => target.path),
      ...(deleteUntracked ? { deleteUntracked, confirmedUntracked: confirmedUntrackedOf(options.targets) } : { deleteUntracked }),
    }))
    if (!result.ok) {
      patch({ busy: false, error: result.error })
      return { kind: 'failed', error: result.error }
    }
    patch({ busy: false, result: result.value })
    return { kind: 'done', value: result.value }
  }

  return {
    getState: emitter.get,
    subscribe: emitter.subscribe,
    setDeleteConfirmed: (confirmed) => { patch({ deleteConfirmed: confirmed }) },
    submit: () => {
      if (inflight !== undefined) return inflight
      const running = run().finally(() => { inflight = undefined })
      inflight = running
      return running
    },
  }
}

export function useRollbackState(store: RollbackStore): RollbackState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
