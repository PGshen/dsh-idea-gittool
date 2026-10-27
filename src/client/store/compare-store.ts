// Compare state (plan B2 T4): commits in `left` but not `right` (paged) and the changed files; a file's
// diff uses the shas the Host resolved, from the merge base (`right...left`), or `left` → worktree.
import { useSyncExternalStore } from 'react'
import type { CommitSummary, CompareRequest, CompareValue, FileEntry, GitError, RpcResult } from '../../shared/protocol.ts'
import { settle } from './blame-store.ts'
import type { DiffStore } from './diff-store.ts'

export interface CompareTarget {
  left: string
  /** null = worktree. */
  right: string | null
}

export interface CompareState {
  target: CompareTarget | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: CompareValue | null
  commits: CommitSummary[]
  files: FileEntry[]
  next?: string
  version?: number
  loadingMore: boolean
  error: GitError | null
  selectedPath: string | null
}

export type CompareLoader = (request: CompareRequest, signal: AbortSignal) => Promise<RpcResult<CompareValue>>

export interface CompareStore {
  getState(): CompareState
  subscribe(listener: () => void): () => void
  open(target: CompareTarget): Promise<void>
  /** Exchange the sides and reload; a worktree comparison cannot swap. */
  swap(): Promise<void>
  canSwap(): boolean
  loadMore(): Promise<void>
  selectFile(path: string): Promise<void>
  close(): void
}

const IDLE: CompareState = { target: null, status: 'idle', value: null, commits: [], files: [], loadingMore: false, error: null, selectedPath: null }

export function createCompareStore(options: { sessionId: string; load: CompareLoader; diff: DiffStore }): CompareStore {
  const listeners = new Set<() => void>()
  let state: CompareState = IDLE
  let controller: AbortController | undefined
  let sequence = 0

  const emit = (next: CompareState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const begin = (): { id: number; signal: AbortSignal } => {
    controller?.abort()
    controller = new AbortController()
    return { id: ++sequence, signal: controller.signal }
  }
  const current = (id: number, signal: AbortSignal): boolean => id === sequence && !signal.aborted
  const request = (target: CompareTarget, cursor?: string): CompareRequest => ({
    sessionId: options.sessionId,
    left: target.left,
    right: target.right,
    ...(cursor === undefined ? {} : { cursor }),
  })

  const open = async (target: CompareTarget): Promise<void> => {
    const { id, signal } = begin()
    options.diff.close()
    emit({ ...IDLE, target, status: 'loading' })
    const result = await settle(options.load(request(target), signal))
    if (!current(id, signal)) return
    if (!result.ok) {
      emit({ ...IDLE, target, status: 'error', error: result.error })
      return
    }
    const value = result.value
    emit({
      ...IDLE,
      target,
      status: 'ready',
      value,
      commits: value.commits,
      files: value.files,
      ...(value.next === undefined ? {} : { next: value.next }),
      ...(value.version === undefined ? {} : { version: value.version }),
    })
  }

  const loadMore = async (): Promise<void> => {
    const { target, next } = state
    if (target === null || next === undefined || state.loadingMore) return
    const { id, signal } = begin()
    emit({ ...state, loadingMore: true })
    const result = await settle(options.load(request(target, next), signal))
    if (!current(id, signal)) return
    if (!result.ok) {
      emit({ ...state, loadingMore: false, error: result.error })
      return
    }
    const page = result.value
    if (page.version !== state.version) {
      await open(target)
      return
    }
    const rest = { ...state }
    delete rest.next
    emit({ ...rest, loadingMore: false, commits: [...state.commits, ...page.commits], ...(page.next === undefined ? {} : { next: page.next }) })
  }

  const canSwap = (): boolean => state.target !== null && state.target.right !== null

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open,
    canSwap,
    swap: async () => {
      const { target } = state
      if (target === null || target.right === null) return
      await open({ left: target.right, right: target.left })
    },
    loadMore,
    selectFile: async (path) => {
      const value = state.value
      if (value === null) return
      emit({ ...state, selectedPath: path })
      await options.diff.open(value.right === null
        ? { sessionId: options.sessionId, path, scope: 'range', from: value.left.sha, to: null }
        : { sessionId: options.sessionId, path, scope: 'range', from: value.right.sha, to: value.left.sha, mergeBase: true })
    },
    close: () => {
      controller?.abort()
      controller = undefined
      sequence += 1
      options.diff.close()
      emit(IDLE)
    },
  }
}

export function useCompareState(store: CompareStore): CompareState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
