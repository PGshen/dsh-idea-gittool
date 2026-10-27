// Blame view state (plan B2 T4): one target at a time, pages appended in order. A response for a
// target the store already left is dropped; a later page from another repository version restarts
// at the first page (the file changed under us, splicing would mix two contents).
import { useSyncExternalStore } from 'react'
import type { BlameCommit, BlameRequest, BlameValue, GitError, RpcResult } from '../../shared/protocol.ts'

export interface BlameTarget {
  path: string
  /** Absent = worktree content. */
  rev?: string
}

/** One rendered line. `segmentStart` marks where the gutter shows the commit. */
export interface BlameRow {
  line: number
  text: string
  sha: string
  segmentStart: boolean
  origPath?: string
}

export type BlameStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface BlameState {
  target: BlameTarget | null
  status: BlameStatus
  /** First page facts (path, resolved rev, totals, binary/tooLarge/unavailable). */
  value: BlameValue | null
  rows: BlameRow[]
  commits: Record<string, BlameCommit>
  next?: number
  version?: number
  loadingMore: boolean
  error: GitError | null
  selectedSha: string | null
}

export type BlameLoader = (request: BlameRequest, signal: AbortSignal) => Promise<RpcResult<BlameValue>>

export interface BlameStore {
  getState(): BlameState
  subscribe(listener: () => void): () => void
  open(target: BlameTarget): Promise<void>
  loadMore(): Promise<void>
  select(sha: string | null): void
  close(): void
}

const IDLE: BlameState = { target: null, status: 'idle', value: null, rows: [], commits: {}, loadingMore: false, error: null, selectedSha: null }

export function createBlameStore(options: { sessionId: string; load: BlameLoader }): BlameStore {
  const listeners = new Set<() => void>()
  let state: BlameState = IDLE
  let controller: AbortController | undefined
  let sequence = 0

  const emit = (next: BlameState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const begin = (): { id: number; signal: AbortSignal } => {
    controller?.abort()
    controller = new AbortController()
    return { id: ++sequence, signal: controller.signal }
  }
  const current = (id: number, signal: AbortSignal): boolean => id === sequence && !signal.aborted

  const request = (target: BlameTarget, start?: number): BlameRequest => ({
    sessionId: options.sessionId,
    path: target.path,
    ...(target.rev === undefined ? {} : { rev: target.rev }),
    ...(start === undefined ? {} : { start }),
  })

  const open = async (target: BlameTarget): Promise<void> => {
    const { id, signal } = begin()
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
      rows: appendRows([], value),
      commits: value.commits,
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
      rows: appendRows(state.rows, page),
      commits: { ...state.commits, ...page.commits },
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
    select: sha => { emit({ ...state, selectedSha: sha }) },
    close: () => {
      controller?.abort()
      controller = undefined
      sequence += 1
      emit(IDLE)
    },
  }
}

/** Rows of one page appended after `rows`; a segment continuing across the page boundary keeps one head. */
function appendRows(rows: BlameRow[], page: BlameValue): BlameRow[] {
  const out = [...rows]
  for (const segment of page.segments) {
    for (let offset = 0; offset < segment.count; offset += 1) {
      const line = segment.start + offset
      const previous = out.at(-1)
      const row: BlameRow = {
        line,
        text: page.lines[line - page.start] ?? '',
        sha: segment.sha,
        segmentStart: previous === undefined || previous.sha !== segment.sha,
      }
      if (segment.origPath !== undefined) row.origPath = segment.origPath
      out.push(row)
    }
  }
  return out
}

/** A loader that throws reads like a Host failure. */
export async function settle<T>(promise: Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await promise
  } catch (error) {
    return { ok: false, error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

export function useBlameState(store: BlameStore): BlameState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
