// Diff 查看器的数据状态机：一次只有一个在途请求；切换文件/关闭时用 AbortController 中止旧请求，
// 迟到响应一律丢弃。RPC 由外部注入（Lead 在 src/client/index.ts 接 git-client）。
import { useSyncExternalStore } from 'react'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_FILE_MAX_LINES,
} from '../../shared/protocol.ts'
import type {
  CommitFileEntry,
  DiffFileValue,
  DiffRequest,
  GitError,
  RpcResult,
} from '../../shared/protocol.ts'

/** Diff 视图的加载状态。 */
export type DiffStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Diff 视图的完整快照；`request` 是当前（或最近一次）打开的文件请求。 */
export interface DiffState {
  request: DiffRequest | null
  status: DiffStatus
  value: DiffFileValue | null
  error: GitError | null
}

/** Diff 加载函数：收到请求与 store 持有的 signal，返回结构化 RPC 信封。 */
export type DiffLoader = (
  request: DiffRequest,
  signal: AbortSignal,
) => Promise<RpcResult<DiffFileValue>>

export interface DiffStore {
  getState(): DiffState
  subscribe(listener: () => void): () => void
  getController(): AbortController | undefined
  getSignal(): AbortSignal | undefined
  /** 打开（或切换到）一个文件的 diff；已有在途请求会被中止。 */
  open(request: DiffRequest): Promise<void>
  /** 用同一请求重试；idle 时不做任何事。 */
  reload(): Promise<void>
  /** 中止在途请求并回到 idle（按 Esc / 关闭查看器时调用）。 */
  close(): void
}

export interface DiffStoreOptions {
  load: DiffLoader
  onChange?: (state: DiffState) => void
}

const IDLE: DiffState = { request: null, status: 'idle', value: null, error: null }

/**
 * 创建 diff store。
 * @param options - 注入的加载函数与可选变更回调。
 * @returns 可订阅的 diff store。
 */
export function createDiffStore(options: DiffStoreOptions): DiffStore {
  const listeners = new Set<() => void>()
  let state: DiffState = IDLE
  let controller: AbortController | undefined
  let sequence = 0

  const emit = (next: DiffState): void => {
    state = next
    options.onChange?.(next)
    for (const listener of listeners) listener()
  }

  const abortInFlight = (): void => {
    if (controller === undefined) return
    controller.abort()
    controller = undefined
  }

  const run = async (request: DiffRequest): Promise<void> => {
    abortInFlight()
    const requestId = ++sequence
    const nextController = new AbortController()
    controller = nextController
    // 同一请求重试时保留旧值，避免闪烁；切换文件时清空。
    const sameRequest = state.request !== null && sameDiffRequest(state.request, request)
    emit({ request, status: 'loading', value: sameRequest ? state.value : null, error: null })
    let result: RpcResult<DiffFileValue>
    try {
      result = await options.load(request, nextController.signal)
    } catch (error) {
      result = {
        ok: false,
        error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) },
      }
    }
    if (requestId !== sequence || nextController.signal.aborted) return
    controller = undefined
    if (result.ok) emit({ request, status: 'ready', value: result.value, error: null })
    else emit({ request, status: 'error', value: null, error: result.error })
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getController: () => controller,
    getSignal: () => controller?.signal,
    open: request => run(request),
    reload: () => (state.request === null ? Promise.resolve() : run(state.request)),
    close: () => {
      abortInFlight()
      sequence += 1
      emit(IDLE)
    },
  }
}

/** 请求身份比较：路径、scope、提交与父提交（B2：以及 range 的两端与合并基）都相同才算同一请求。 */
function sameDiffRequest(left: DiffRequest, right: DiffRequest): boolean {
  return (
    left.path === right.path &&
    left.scope === right.scope &&
    left.sha === right.sha &&
    left.parent === right.parent &&
    left.from === right.from &&
    left.to === right.to &&
    left.mergeBase === right.mergeBase &&
    left.origPath === right.origPath
  )
}

/**
 * 把 diff store 接进 React；快照在两次 emit 之间保持引用稳定。
 * @param store - diff store。
 * @returns 当前快照。
 */
export function useDiffState(store: DiffStore): DiffState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

/** diff 里渲染出来的行数（截断提示用它说明「前 N 行」）。 */
export function diffLineCount(value: Pick<DiffFileValue, 'hunks'>): number {
  return value.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
}

/** 没有 hunk 且不是二进制 → 「没有文本差异」（设计 §9.3）。 */
export function hasNoTextChange(value: Pick<DiffFileValue, 'hunks' | 'binary'>): boolean {
  return !value.binary && value.hunks.length === 0
}

/** 单段 shell 参数加引号：只有安全字符时原样输出。 */
export function shellQuote(text: string): string {
  if (/^[\w./@%+,=:~^-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * 生成「在终端查看」命令（设计 §9.3/§9.4 的复制命令）。
 * @param request - 当前 diff 请求。
 * @returns 可直接粘贴到终端的 git 命令。
 */
export function terminalCommandFor(request: DiffRequest): string {
  const path = shellQuote(request.path)
  if (request.scope === 'staged') return `git diff --cached -- ${path}`
  if (request.scope === 'worktree') return `git diff -- ${path}`
  if (request.sha === undefined) return `git log -p -1 -- ${path}`
  if (request.parent !== undefined) {
    return `git diff ${shellQuote(request.parent)} ${shellQuote(request.sha)} -- ${path}`
  }
  return `git show ${shellQuote(request.sha)} -- ${path}`
}

/**
 * 截断提示文案；未截断或二进制（由二进制面板说明）时返回 undefined。
 * @param value - 服务端返回的 diff。
 * @returns 面向用户的一句提示。
 */
export function truncationNotice(value: DiffFileValue): LocalizedText | undefined {
  if (!value.truncated || value.truncatedReason === 'binary') return undefined
  return value.truncatedReason === 'bytes'
    ? text('diff.truncated.bytes', { count: diffLineCount(value), limit: Math.round(DIFF_FILE_MAX_BYTES / 1024) })
    : text('diff.truncated.lines', { count: diffLineCount(value), limit: DIFF_FILE_MAX_LINES })
}

/** 字节数的人类可读形式（二进制文件大小，设计 §9.3）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * 把文件列表里的一项换算成 diff 请求：沿用 base 的 scope/sha，换路径；
 * 合并提交分组里的文件带 parentSha，作为比较的父提交。
 * @param base - 当前（来源）请求。
 * @param file - 要切换到的文件。
 * @returns 新的 diff 请求。
 */
export function requestForFile(base: DiffRequest, file: CommitFileEntry): DiffRequest {
  const next: DiffRequest = { ...base, path: file.path }
  if (file.parentSha !== undefined) next.parent = file.parentSha
  return next
}

/**
 * 在文件列表里定位请求对应的文件；带 parentSha 的条目还要求父提交一致。
 * @returns 下标；找不到时为 -1。
 */
export function fileIndexOf(files: readonly CommitFileEntry[], request: DiffRequest): number {
  return files.findIndex(file =>
    file.path === request.path && (file.parentSha === undefined || file.parentSha === request.parent))
}

export interface DiffViewerControllerOptions {
  store: DiffStore
  /**
   * 可切换的文件（通常是提交的变更文件）；省略时只能看当前文件。
   * 传函数时每次按需读取，组件可用它读最新 props 而不必重建控制器。
   */
  files?: readonly CommitFileEntry[] | (() => readonly CommitFileEntry[])
  /** 关闭查看器（Esc / 返回）。参数是关闭前的请求，调用方据此恢复来源页选中。 */
  onClose: (last: DiffRequest | null) => void
  /** 切换文件后通知调用方（同步来源页的文件选中）。 */
  onSwitchFile?: (request: DiffRequest, file: CommitFileEntry) => void
}

export interface DiffViewerPosition {
  index: number
  total: number
  hasPrev: boolean
  hasNext: boolean
}

export interface DiffViewerController {
  /** 打开初始请求（不触发 onSwitchFile）。 */
  start(request: DiffRequest): Promise<void>
  switchTo(file: CommitFileEntry): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  position(): DiffViewerPosition
  /** 中止在途请求、回到 idle，并回调 onClose。 */
  close(): void
  /** 处理按键；返回 true 表示已处理（调用方应 preventDefault）。 */
  handleKey(event: { key: string; defaultPrevented: boolean }): boolean
  /** B3b：忽略空白 / 整文件上下文；重新打开当前文件，之后切换文件沿用。 */
  setOptions(options: DiffViewOptions): Promise<void>
}

/** B3b diff options carried on every request of the viewer. */
export interface DiffViewOptions {
  ignoreWhitespace: boolean
  context: 'default' | 'full'
}

/** `request` with `options` applied; defaults are left out so cache keys and requests stay as before. */
export function withDiffOptions(request: DiffRequest, options: DiffViewOptions): DiffRequest {
  const next: DiffRequest = { ...request }
  delete next.ignoreWhitespace
  delete next.context
  if (options.ignoreWhitespace) next.ignoreWhitespace = true
  if (options.context === 'full') next.context = 'full'
  return next
}

/**
 * Diff 查看器的交互控制器：文件切换、Esc 关闭都经由这里，保证切换/关闭时中止 RPC。
 * 与 React 无关，组件只负责把事件转发进来。
 * @param options - diff store、文件列表与回调。
 * @returns 控制器。
 */
export function createDiffViewerController(options: DiffViewerControllerOptions): DiffViewerController {
  const filesOf = (): readonly CommitFileEntry[] =>
    (typeof options.files === 'function' ? options.files() : options.files ?? [])
  let current: DiffRequest | null = null

  const indexOfCurrent = (): number => (current === null ? -1 : fileIndexOf(filesOf(), current))

  const switchTo = (file: CommitFileEntry): Promise<void> => {
    if (current === null) return Promise.resolve()
    const next = requestForFile(current, file)
    current = next
    options.onSwitchFile?.(next, file)
    return options.store.open(next)
  }

  const step = (delta: number): Promise<void> => {
    const index = indexOfCurrent()
    const target = index === -1 ? undefined : filesOf()[index + delta]
    return target === undefined ? Promise.resolve() : switchTo(target)
  }

  return {
    start: (request) => {
      current = request
      return options.store.open(request)
    },
    switchTo,
    next: () => step(1),
    prev: () => step(-1),
    position: () => {
      const total = filesOf().length
      const index = indexOfCurrent()
      return { index, total, hasPrev: index > 0, hasNext: index !== -1 && index < total - 1 }
    },
    close: () => {
      const last = current
      options.store.close()
      options.onClose(last)
    },
    setOptions: (diffOptions) => {
      if (current === null) return Promise.resolve()
      current = withDiffOptions(current, diffOptions)
      return options.store.open(current)
    },
    handleKey: (event) => {
      if (event.defaultPrevented || event.key !== 'Escape') return false
      const last = current
      options.store.close()
      options.onClose(last)
      return true
    },
  }
}
