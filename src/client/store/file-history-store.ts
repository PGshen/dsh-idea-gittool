// File history state (plan B2 T4): entries paged in order; the selected entry's diff goes through the
// shared diff store with the path the file had in that commit (pre-rename entries carry the old path).
import { useSyncExternalStore } from 'react'
import type { FileHistoryEntry, FileHistoryRequest, FileHistoryValue, GitError, RpcResult } from '../../shared/protocol.ts'
import { settle } from './blame-store.ts'
import type { DiffStore } from './diff-store.ts'

export interface FileHistoryTarget {
  path: string
  rev?: string
}

export interface FileHistoryState {
  target: FileHistoryTarget | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: FileHistoryEntry[]
  next?: string
  version?: number
  followedRename: boolean
  loadingMore: boolean
  error: GitError | null
  selectedSha: string | null
}

export type FileHistoryLoader = (request: FileHistoryRequest, signal: AbortSignal) => Promise<RpcResult<FileHistoryValue>>

export interface FileHistoryStore {
  getState(): FileHistoryState
  subscribe(listener: () => void): () => void
  open(target: FileHistoryTarget): Promise<void>
  loadMore(): Promise<void>
  select(sha: string): Promise<void>
  close(): void
}

const IDLE: FileHistoryState = { target: null, status: 'idle', entries: [], followedRename: false, loadingMore: false, error: null, selectedSha: null }

export function createFileHistoryStore(options: { sessionId: string; load: FileHistoryLoader; diff: DiffStore }): FileHistoryStore {
  const listeners = new Set<() => void>()
  let state: FileHistoryState = IDLE
  let controller: AbortController | undefined
  let sequence = 0

  const emit = (next: FileHistoryState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const begin = (): { id: number; signal: AbortSignal } => {
    controller?.abort()
    controller = new AbortController()
    return { id: ++sequence, signal: controller.signal }
  }
  const current = (id: number, signal: AbortSignal): boolean => id === sequence && !signal.aborted
  const request = (target: FileHistoryTarget, cursor?: string): FileHistoryRequest => ({
    sessionId: options.sessionId,
    path: target.path,
    ...(target.rev === undefined ? {} : { rev: target.rev }),
    ...(cursor === undefined ? {} : { cursor }),
  })

  const open = async (target: FileHistoryTarget): Promise<void> => {
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
      entries: value.entries,
      followedRename: value.followedRename,
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
    emit({
      ...rest,
      loadingMore: false,
      entries: [...state.entries, ...page.entries],
      followedRename: state.followedRename || page.followedRename,
      ...(page.next === undefined ? {} : { next: page.next }),
    })
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open,
    loadMore,
    select: async (sha) => {
      const entry = state.entries.find(candidate => candidate.sha === sha)
      if (entry === undefined) return
      emit({ ...state, selectedSha: sha })
      await options.diff.open({ sessionId: options.sessionId, path: entry.path, scope: 'commit', sha })
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

export function useFileHistoryState(store: FileHistoryStore): FileHistoryState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
