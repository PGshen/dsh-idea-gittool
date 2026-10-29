// A3 write-action pipeline (plan T6): every write entry point goes through `actions.run`, which
// owns request → loading → error → smart-stash ask → retry. React-free; the workbench subscribes.
// - One requestId per send; the "stash and continue" resend gets a new one.
// - A repeated call for the same endpoint + target while it is running (or asking) returns the
//   in-flight promise instead of sending again.
// - `git/dirty-worktree` with `smartStash` asks the user (DirtyWorktreeSheet); cancel sends nothing.
// - `git/conflict` notifies the workbench so it can open the conflict list.
// - Other failures map to a LocalizedText; the raw GitError is kept for A2 notices (auth command).
import { useSyncExternalStore } from 'react'
import type {
  ConflictDetails,
  GitError,
  GitErrorCode,
  RpcEndpointTypes,
  RpcResult,
  SmartOperationKind,
  SmartWriteRequest,
  StaleTargetDetails,
  WriteEndpoint,
} from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import type { WriteMethods } from '../git-client.ts'
import { newRequestId as defaultRequestId } from '../git-client.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import { SKIPPABLE } from '../operations.ts'

/** The write methods of GitClient (fakes in tests implement only what they use). */
export type ActionClient = WriteMethods

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Request without the fields the store fills in. */
export type ActionPayload<K extends WriteEndpoint> = DistributiveOmit<RpcEndpointTypes[K]['request'], 'sessionId' | 'requestId'>

export type ActionValue<K extends WriteEndpoint> = RpcEndpointTypes[K]['value']

/** Write endpoints whose request accepts `stash: true` (smart operations). */
export type SmartEndpoint = {
  [K in WriteEndpoint]: RpcEndpointTypes[K]['request'] extends SmartWriteRequest ? K : never
}[WriteEndpoint]

export interface RunOptions<K extends WriteEndpoint> {
  /** De-duplication target (branch name, sha, path…); defaults to the whole payload. */
  target?: string
  /** Ask "stash and continue / cancel" on `git/dirty-worktree` (smart endpoints only). */
  smartStash?: K extends SmartEndpoint ? SmartOperationKind : never
  /**
   * The control the user clicked, captured at click time. Overlays opened later by this action
   * (dirty-worktree question, conflict list) return focus to it; `document.activeElement` is
   * already stale by then.
   */
  trigger?: FocusTarget | null
}

export type ActionOutcome<V> =
  | { kind: 'done'; value: V }
  | { kind: 'failed'; error: GitError; message: LocalizedText }
  | { kind: 'conflict'; error: GitError; details: ConflictDetails }
  /** The user cancelled the stash question; nothing was changed. */
  | { kind: 'cancelled' }

export type ActionStatus = 'running' | 'asking-stash'

/** The open "uncommitted changes" question (shown by DirtyWorktreeSheet). */
export interface StashAsk {
  /** {@link actionKey} of the waiting action. */
  key: string
  endpoint: WriteEndpoint
  operation: SmartOperationKind
  /** First changed paths reported by the Host (at most DIRTY_PATHS_LIMIT). */
  paths: string[]
  /** Total number of changed paths. */
  count: number
  /** {@link RunOptions.trigger} of the waiting action (null when none was given). */
  trigger: FocusTarget | null
}

export interface ActionState {
  /** In-flight actions by {@link actionKey}. */
  pending: Readonly<Record<string, ActionStatus>>
  ask: StashAsk | null
}

export interface ActionStoreDeps {
  client: ActionClient
  sessionId: string
  newRequestId?: () => string
  /** A dirty-worktree question opened (the workbench shows the sheet). */
  onAskStash?: (ask: StashAsk) => void
  /** The operation stopped on conflicts (the workbench opens the conflict list). */
  onConflict?: (endpoint: WriteEndpoint, details: ConflictDetails, trigger: FocusTarget | null) => void
  /** A write succeeded (the workbench refreshes). */
  onSuccess?: (endpoint: WriteEndpoint, value: unknown) => void
}

export interface ActionStore {
  getState(): ActionState
  subscribe(listener: () => void): () => void
  run<K extends WriteEndpoint>(endpoint: K, payload: ActionPayload<K>, options?: RunOptions<K>): Promise<ActionOutcome<ActionValue<K>>>
  isRunning<K extends WriteEndpoint>(endpoint: K, payload: ActionPayload<K>, target?: string): boolean
  /** Answer the open question with "stash and continue": resend with `stash: true`. */
  confirmStash(): void
  /** Answer the open question with "cancel": nothing is sent. */
  cancelStash(): void
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** De-duplication key: endpoint + explicit target, else endpoint + the payload. */
export function actionKey(endpoint: WriteEndpoint, payload: unknown, target?: string): string {
  return `${endpoint}:${target ?? stableStringify(payload)}`
}

function detailsOf(error: GitError): Record<string, unknown> {
  return error.details ?? {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function dirtyDetails(error: GitError): { paths: string[]; count: number } {
  const details = detailsOf(error)
  const paths = stringArray(details['paths'])
  return { paths, count: numberOr(details['count'], paths.length) }
}

/** A2 write codes keep their A2 texts (hook-failed, auth-required, …). */
const A2_WRITE_KEY: Partial<Record<GitErrorCode, GitWorkbenchKey>> = {
  'git/auth-required': 'write.error.git/auth-required',
  'git/locked': 'write.error.git/locked',
  'git/hook-failed': 'write.error.git/hook-failed',
  'git/sandbox-denied': 'write.error.git/sandbox-denied',
  'git/timeout': 'write.error.git/timeout',
  'git/operation-in-progress': 'write.error.git/operation-in-progress',
}

const STALE_TARGET_KEY: Record<StaleTargetDetails['target'], GitWorkbenchKey> = {
  stash: 'action.error.git/stale-target.stash',
  conflict: 'action.error.git/stale-target.conflict',
  head: 'action.error.git/stale-target.head',
  branch: 'action.error.git/stale-target.branch',
}

const INVALID_REASON_KEY: Record<string, GitWorkbenchKey> = {
  'nothing-to-stash': 'action.error.nothing-to-stash',
  'no-upstream': 'action.error.no-upstream',
  'body-too-large': 'action.error.body-too-large',
  // B3a interactive rebase: list validation and ranges the Host refuses.
  'not-permutation': 'rebase.invalid.not-permutation',
  'leading-squash': 'rebase.invalid.leading-squash',
  'missing-message': 'rebase.invalid.missing-message',
  'misplaced-message': 'rebase.invalid.misplaced-message',
  'not-ancestor': 'rebase.blocked.not-ancestor',
  detached: 'rebase.blocked.detached',
  empty: 'rebase.blocked.empty',
  // T1: worktree removals the Host refuses.
  'main-worktree': 'worktrees.remove.main',
  'current-worktree': 'worktrees.remove.current',
  'worktree-locked': 'worktrees.remove.locked',
}

/** Error code (+ details) → localized, actionable text. */
export function actionErrorText(error: GitError): LocalizedText {
  const a2 = A2_WRITE_KEY[error.code]
  if (a2 !== undefined) return text(a2)
  const details = detailsOf(error)
  switch (error.code) {
    case 'git/would-overwrite':
      return text('action.error.git/would-overwrite', { count: stringArray(details['paths']).length })
    case 'git/not-merged':
      return text('action.error.git/not-merged', { branch: String(details['branch'] ?? '') })
    case 'git/branch-exists':
      // B3b: `createTag` reports a taken tag name with the same code.
      if (details['kind'] === 'tag') return text('tag.exists', { name: String(details['branch'] ?? '') })
      return text('action.error.git/branch-exists', { branch: String(details['branch'] ?? '') })
    case 'git/dirty-worktree':
      return text('action.error.git/dirty-worktree', { count: dirtyDetails(error).count })
    case 'git/upstream-rewritten':
      return text('action.error.git/upstream-rewritten', { count: numberOr(details['localAhead'], 0) })
    case 'git/rejected':
      // T1: a rejected tag push carries git's own reason (`[rejected] (already exists)`, `remote:` lines).
      if (details['target'] === 'tag') {
        const reason = [details['summary'], details['remoteMessage']].filter((part): part is string => typeof part === 'string' && part !== '').join(' — ')
        return text('tag.push.rejected', { name: String(details['name'] ?? ''), remote: String(details['remote'] ?? ''), reason })
      }
      break
    case 'git/conflict':
      return text('action.error.git/conflict')
    case 'git/paths-changed':
      return text('action.error.git/paths-changed')
    case 'git/stale-target': {
      const target = details['target']
      const key = typeof target === 'string' ? STALE_TARGET_KEY[target as StaleTargetDetails['target']] : undefined
      return text(key ?? 'action.error.git/stale-target')
    }
    case 'git/exec-failed': {
      // Carry 3: an empty cherry-pick / revert stops in the operation; the banner skips or aborts.
      const operation = details['operation']
      if (details['reason'] === 'empty' && typeof operation === 'string') {
        return text((SKIPPABLE as ReadonlySet<string>).has(operation) ? 'action.error.empty' : 'action.error.empty.abortOnly')
      }
      break
    }
    case 'git/invalid-payload': {
      const reason = details['reason']
      const key = typeof reason === 'string' ? INVALID_REASON_KEY[reason] : undefined
      if (key !== undefined) return text(key)
      break
    }
    default:
      break
  }
  return text('action.error.fallback', { code: error.code, message: error.message })
}

function thrownError(error: unknown): GitError {
  return { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) }
}

type StashAnswer = 'stash' | 'cancel'

export function createActionStore(deps: ActionStoreDeps): ActionStore {
  const nextRequestId = deps.newRequestId ?? defaultRequestId
  const listeners = new Set<() => void>()
  const inflight = new Map<string, Promise<ActionOutcome<unknown>>>()
  let state: ActionState = { pending: {}, ask: null }
  let answerAsk: ((answer: StashAnswer) => void) | null = null

  function setState(next: ActionState): void {
    state = next
    for (const listener of listeners) listener()
  }

  function setPending(key: string, status: ActionStatus | null): void {
    const pending = { ...state.pending }
    if (status === null) delete pending[key]
    else pending[key] = status
    setState({ ...state, pending })
  }

  async function send<K extends WriteEndpoint>(
    endpoint: K,
    payload: ActionPayload<K>,
    extra: { stash?: true },
  ): Promise<RpcResult<ActionValue<K>>> {
    const request = { ...payload, ...extra, sessionId: deps.sessionId, requestId: nextRequestId() } as RpcEndpointTypes[K]['request']
    try {
      const method = deps.client[endpoint]
      return await method(request)
    } catch (error) {
      return { ok: false, error: thrownError(error) }
    }
  }

  function ask(question: StashAsk): Promise<StashAnswer> {
    // Only one question at a time: an unanswered one is cancelled (nothing was sent for it).
    answerAsk?.('cancel')
    return new Promise<StashAnswer>(resolve => {
      answerAsk = resolve
      setState({ pending: { ...state.pending, [question.key]: 'asking-stash' }, ask: question })
      deps.onAskStash?.(question)
    })
  }

  function answer(value: StashAnswer): void {
    const resolve = answerAsk
    if (resolve === null) return
    answerAsk = null
    setState({ ...state, ask: null })
    resolve(value)
  }

  function outcomeOf<K extends WriteEndpoint>(
    endpoint: K,
    result: RpcResult<ActionValue<K>>,
    trigger: FocusTarget | null,
  ): ActionOutcome<ActionValue<K>> {
    if (result.ok) {
      deps.onSuccess?.(endpoint, result.value)
      return { kind: 'done', value: result.value }
    }
    const { error } = result
    if (error.code === 'git/conflict') {
      const details = (error.details ?? {}) as ConflictDetails
      deps.onConflict?.(endpoint, details, trigger)
      return { kind: 'conflict', error, details }
    }
    return { kind: 'failed', error, message: actionErrorText(error) }
  }

  async function execute<K extends WriteEndpoint>(
    endpoint: K,
    payload: ActionPayload<K>,
    key: string,
    options: RunOptions<K>,
  ): Promise<ActionOutcome<ActionValue<K>>> {
    let result = await send(endpoint, payload, {})
    const operation = options.smartStash
    const trigger = options.trigger ?? null
    // Carry 2: without `details.operation` (resetToRemote, or untracked files in the way) a stash
    // cannot help, so the question is never asked.
    if (!result.ok && result.error.code === 'git/dirty-worktree' && operation !== undefined && detailsOf(result.error)['operation'] !== undefined) {
      const reply = await ask({ key, endpoint, operation, ...dirtyDetails(result.error), trigger })
      if (reply === 'cancel') return { kind: 'cancelled' }
      setPending(key, 'running')
      result = await send(endpoint, payload, { stash: true })
    }
    return outcomeOf(endpoint, result, trigger)
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    run: (endpoint, payload, options = {}) => {
      const key = actionKey(endpoint, payload, options.target)
      const existing = inflight.get(key)
      if (existing !== undefined) return existing as Promise<ActionOutcome<ActionValue<typeof endpoint>>>
      setPending(key, 'running')
      const promise = execute(endpoint, payload, key, options).finally(() => {
        inflight.delete(key)
        setPending(key, null)
      })
      inflight.set(key, promise)
      return promise
    },
    isRunning: (endpoint, payload, target) => state.pending[actionKey(endpoint, payload, target)] !== undefined,
    confirmStash: () => { answer('stash') },
    cancelStash: () => { answer('cancel') },
  }
}

export function useActionState(store: ActionStore): ActionState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
