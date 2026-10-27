// Interactive rebase page state (plan b3a T4): one plan at a time, the editable rows, the two options and
// the submit through the action store (smart stash question, error copy, conflict list). A plan response
// for a base the store already left is dropped.
import { useSyncExternalStore } from 'react'
import type { GitError, InteractiveRebaseValue, RebasePlanRequest, RebasePlanValue, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import type { LocalizedText } from '../localized-text.ts'
import { fromPlan, rewritesPushed, toEntries, validate } from '../rebase/rebase-model.ts'
import type { RebasePreset, RebaseRow } from '../rebase/rebase-model.ts'
import type { ActionOutcome, ActionStore } from './action-store.ts'
import { settle } from './blame-store.ts'

export interface RebaseState {
  /** Base the page was opened for (null = from the root). */
  base: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  plan: RebasePlanValue | null
  rows: RebaseRow[]
  error: GitError | null
  updateRefs: boolean
  confirmPushed: boolean
  /** Some commit already on a remote would be rewritten. */
  rewritesPushed: boolean
  /** Why submit is disabled, or null. */
  invalid: LocalizedText | null
  submitting: boolean
}

export type RebasePlanLoader = (request: RebasePlanRequest, signal: AbortSignal) => Promise<RpcResult<RebasePlanValue>>

export interface RebaseStore {
  getState(): RebaseState
  subscribe(listener: () => void): () => void
  open(base: string | null, preset?: RebasePreset): Promise<void>
  update(change: (rows: RebaseRow[]) => RebaseRow[]): void
  setUpdateRefs(on: boolean): void
  setConfirmPushed(on: boolean): void
  /** Undefined when nothing was sent (invalid list, already submitting, no plan). */
  submit(trigger: FocusTarget | null): Promise<ActionOutcome<InteractiveRebaseValue> | undefined>
  close(): void
}

/** De-duplication target of the action store: one interactive rebase at a time. */
export const INTERACTIVE_REBASE_TARGET = 'interactive-rebase'

const IDLE: RebaseState = {
  base: null,
  status: 'idle',
  plan: null,
  rows: [],
  error: null,
  updateRefs: false,
  confirmPushed: false,
  rewritesPushed: false,
  invalid: null,
  submitting: false,
}

export function createRebaseStore(options: {
  sessionId: string
  load: RebasePlanLoader
  actions: Pick<ActionStore, 'run'>
}): RebaseStore {
  const listeners = new Set<() => void>()
  let state: RebaseState = IDLE
  let controller: AbortController | undefined
  let sequence = 0

  /** Recompute the derived fields and notify. */
  const emit = (next: RebaseState): void => {
    const derived = next.plan === null
      ? { rewritesPushed: false, invalid: null }
      : {
          rewritesPushed: rewritesPushed(next.rows),
          invalid: validate(next.plan, next.rows, { confirmPushed: next.confirmPushed }),
        }
    state = { ...next, ...derived }
    for (const listener of listeners) listener()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open: async (base, preset) => {
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      const id = ++sequence
      emit({ ...IDLE, base, status: 'loading' })
      const result = await settle(options.load({ sessionId: options.sessionId, base }, signal))
      if (id !== sequence || signal.aborted) return
      if (!result.ok) {
        emit({ ...IDLE, base, status: 'error', error: result.error })
        return
      }
      emit({ ...IDLE, base, status: 'ready', plan: result.value, rows: fromPlan(result.value, preset) })
    },
    update: (change) => {
      if (state.plan === null) return
      emit({ ...state, rows: change(state.rows) })
    },
    setUpdateRefs: (on) => { emit({ ...state, updateRefs: on }) },
    setConfirmPushed: (on) => { emit({ ...state, confirmPushed: on }) },
    submit: async (trigger) => {
      const plan = state.plan
      if (plan === null || state.submitting || state.invalid !== null) return undefined
      emit({ ...state, submitting: true })
      try {
        return await options.actions.run(
          'interactiveRebase',
          {
            base: plan.base,
            head: plan.head,
            entries: toEntries(state.rows),
            updateRefs: state.updateRefs && plan.supportsUpdateRefs,
          },
          { smartStash: 'rebase', target: INTERACTIVE_REBASE_TARGET, trigger },
        )
      } finally {
        emit({ ...state, submitting: false })
      }
    },
    close: () => {
      controller?.abort()
      controller = undefined
      sequence += 1
      emit(IDLE)
    },
  }
}

export function useRebaseState(store: RebaseStore): RebaseState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
