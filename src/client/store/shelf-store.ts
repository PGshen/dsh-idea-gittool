// Shelf list state (plan b3c T3): entries newest first, the selected entry and its patch. A patch
// response for an entry the user already left is dropped; a refresh keeps the selection while the
// entry still exists.
import { useSyncExternalStore } from 'react'
import type { GitError, RpcRequest, RpcResult, ShelfEntry, ShelfListValue, ShelfPatchRequest, ShelfPatchValue } from '../../shared/protocol.ts'
import { settle } from './blame-store.ts'

export interface ShelfState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  shelves: ShelfEntry[]
  selectedId: string | null
  patch: string | null
  patchError: GitError | null
  error: GitError | null
}

export interface ShelfStore {
  getState(): ShelfState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  select(id: string): Promise<void>
}

export function createShelfStore(options: {
  sessionId: string
  list: (request: RpcRequest, signal?: AbortSignal) => Promise<RpcResult<ShelfListValue>>
  patch: (request: ShelfPatchRequest, signal?: AbortSignal) => Promise<RpcResult<ShelfPatchValue>>
}): ShelfStore {
  const listeners = new Set<() => void>()
  let state: ShelfState = { status: 'idle', shelves: [], selectedId: null, patch: null, patchError: null, error: null }
  let patchSequence = 0
  const emit = (next: Partial<ShelfState>): void => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const select = async (id: string): Promise<void> => {
    const sequence = ++patchSequence
    emit({ selectedId: id, patch: null, patchError: null })
    const result = await settle(options.patch({ sessionId: options.sessionId, id }))
    if (sequence !== patchSequence) return
    emit(result.ok ? { patch: result.value.patch } : { patchError: result.error })
  }
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: async () => {
      emit({ status: state.status === 'ready' ? 'ready' : 'loading' })
      const result = await settle(options.list({ sessionId: options.sessionId }))
      if (!result.ok) {
        emit({ status: 'error', error: result.error })
        return
      }
      const shelves = result.value.shelves
      const keep = shelves.find(entry => entry.id === state.selectedId)?.id ?? shelves[0]?.id ?? null
      emit({ status: 'ready', shelves, error: null })
      if (keep === null) emit({ selectedId: null, patch: null, patchError: null })
      else if (keep !== state.selectedId || state.patch === null) await select(keep)
    },
    select,
  }
}

export function useShelfState(store: ShelfStore): ShelfState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
