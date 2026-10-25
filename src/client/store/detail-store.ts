// 提交详情的数据状态机：一次只有一个在途请求，新选中/关闭时用 AbortController 中止旧请求，
// 迟到的响应一律丢弃。RPC 调用由外部注入（Lead 在 src/client/index.ts 接 git-client），
// 这样组件与 store 都能在无 DOM 的单测里运行。
import { useSyncExternalStore } from 'react'
import type { CommitDetailValue, GitError, RpcResult } from '../../shared/protocol.ts'

/** 详情视图的加载状态。 */
export type DetailStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 详情视图的完整快照；`sha` 是当前选中（或最近一次选中）的提交。 */
export interface DetailState {
  sha: string | null
  status: DetailStatus
  value: CommitDetailValue | null
  error: GitError | null
}

/** 详情加载函数：收到 sha 与 store 持有的 signal，返回结构化 RPC 信封。 */
export type CommitDetailLoader = (
  sha: string,
  signal: AbortSignal,
) => Promise<RpcResult<CommitDetailValue>>

export interface DetailStore {
  getState(): DetailState
  subscribe(listener: () => void): () => void
  /** 当前在途请求的 AbortController；没有在途请求时为 undefined。 */
  getController(): AbortController | undefined
  /** 当前在途请求的 signal，便于调用方在别处（如超时）复用。 */
  getSignal(): AbortSignal | undefined
  /** 选中提交并加载详情；已有在途请求会被中止。 */
  select(sha: string): Promise<void>
  /** 重新加载当前提交；没有当前 sha 时不做任何事。 */
  reload(): Promise<void>
  /** 中止在途请求并回到 idle（关闭详情页时调用）。 */
  cancel(): void
}

export interface DetailStoreOptions {
  load: CommitDetailLoader
  /** 状态变化回调，便于容器同步到自己的状态（可选）。 */
  onChange?: (state: DetailState) => void
}

const IDLE: DetailState = { status: 'idle', sha: null, value: null, error: null }

/**
 * 创建提交详情 store。
 * @param options - 注入的加载函数与可选变更回调。
 * @returns 可订阅的详情 store。
 */
export function createDetailStore(options: DetailStoreOptions): DetailStore {
  const listeners = new Set<() => void>()
  let state: DetailState = IDLE
  let controller: AbortController | undefined
  /** 请求序号：只有最后一次 select/reload 的响应会被接受。 */
  let sequence = 0

  const emit = (next: DetailState): void => {
    state = next
    options.onChange?.(next)
    for (const listener of listeners) listener()
  }

  const abortInFlight = (): void => {
    if (controller === undefined) return
    controller.abort()
    controller = undefined
  }

  const run = async (sha: string): Promise<void> => {
    abortInFlight()
    const requestId = ++sequence
    const nextController = new AbortController()
    controller = nextController
    emit({ status: 'loading', sha, value: state.sha === sha ? state.value : null, error: null })
    let result: RpcResult<CommitDetailValue>
    try {
      result = await options.load(sha, nextController.signal)
    } catch (error) {
      result = {
        ok: false,
        error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) },
      }
    }
    // 过期请求（已有更新的选中）或已被取消：丢弃，不写状态。
    if (requestId !== sequence || nextController.signal.aborted) return
    controller = undefined
    if (result.ok) emit({ status: 'ready', sha, value: result.value, error: null })
    else emit({ status: 'error', sha, value: null, error: result.error })
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getController: () => controller,
    getSignal: () => controller?.signal,
    select: (sha) => run(sha),
    reload: () => (state.sha === null ? Promise.resolve() : run(state.sha)),
    cancel: () => {
      abortInFlight()
      sequence += 1
      emit(IDLE)
    },
  }
}

/**
 * 把详情 store 接进 React；`getState` 的返回值在两次 emit 之间保持不变，
 * 满足 useSyncExternalStore 的快照要求。
 * @param store - 详情 store。
 * @returns 当前快照。
 */
export function useDetailState(store: DetailStore): DetailState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
