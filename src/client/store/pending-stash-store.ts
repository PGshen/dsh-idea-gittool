// Pending smart stash outside an operation (final review 2b): the operation that stashed the
// user's changes ended outside the UI (terminal, Agent), so nothing restored them. While an
// operation is open the banner tells it; once none is open, operationState is read again only
// when the repository version moves (never on every status poll) and only when stashes exist.
// React-free; the workbench creates one store per session.
import { useSyncExternalStore } from 'react'
import type { OperationStateValue, RepoOperation, RpcResult } from '../../shared/protocol.ts'

export interface PendingStashState {
  /** A pending stash waits and no operation is open: show the restore bar. */
  pending: boolean
}

export interface PendingStashStoreDeps {
  load: () => Promise<RpcResult<OperationStateValue>>
}

/** What the status says right now. */
export interface PendingStashInput {
  operation: RepoOperation
  version: number
  stashCount: number
}

export type PendingStashCheck = 'load' | 'keep' | 'clear'

/** `lastVersion`: the version last checked (null: never, or cleared since). */
export function pendingStashCheck(lastVersion: number | null, input: PendingStashInput): PendingStashCheck {
  if (input.operation !== null || input.stashCount === 0) return 'clear'
  return lastVersion === input.version ? 'keep' : 'load'
}

export interface PendingStashStore {
  getState(): PendingStashState
  subscribe(listener: () => void): () => void
  /** Follow the status; loads only per {@link pendingStashCheck}. */
  sync(input: PendingStashInput): Promise<void>
  /** Reload now (after a restore attempt); a no-op before the first idle sync. */
  recheck(): Promise<void>
}

const HIDDEN: PendingStashState = { pending: false }
const SHOWN: PendingStashState = { pending: true }

export function createPendingStashStore(deps: PendingStashStoreDeps): PendingStashStore {
  const listeners = new Set<() => void>()
  let state = HIDDEN
  let lastVersion: number | null = null
  let seq = 0

  const emit = (next: PendingStashState): void => {
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener()
  }

  const load = async (): Promise<void> => {
    const mine = ++seq
    let result: RpcResult<OperationStateValue>
    try {
      result = await deps.load()
    } catch {
      return
    }
    // A newer sync (or a clear) superseded this answer; a failed read keeps what is shown.
    if (mine !== seq || !result.ok) return
    emit(result.value.operation === null && result.value.pendingStash ? SHOWN : HIDDEN)
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sync: async (input) => {
      const check = pendingStashCheck(lastVersion, input)
      if (check === 'keep') return
      if (check === 'clear') {
        seq += 1
        lastVersion = null
        emit(HIDDEN)
        return
      }
      lastVersion = input.version
      await load()
    },
    recheck: async () => {
      if (lastVersion === null) return
      await load()
    },
  }
}

export function usePendingStashState(store: PendingStashStore): PendingStashState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
