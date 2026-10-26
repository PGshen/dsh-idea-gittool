// Git 控制台的数据层（设计 §12）：轮询 console 端点、客户端兜底脱敏与截断、清空水位、展开/暂停状态。
// RPC 由外部注入（Lead 在 src/client/index.ts 接 git-client 的 console 端点）；不依赖 DOM。
import { useSyncExternalStore } from 'react'
import { CONSOLE_OUTPUT_MAX_BYTES } from '../../shared/protocol.ts'
import type { ConsoleRecord, ConsoleValue, GitError, RpcResult } from '../../shared/protocol.ts'
import { createPoller, DEFAULT_POLL_INTERVAL_MS } from '../polling.ts'
import type { Poller } from '../polling.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'

// ---------------------------------------------------------------------------
// 纯函数：脱敏、截断、argv 拆分与展示
// ---------------------------------------------------------------------------

/** 紧挨 `://` 之前、且前面是词边界的协议名（最长 32 个字符）。 */
const SCHEME_BEFORE_SEPARATOR = /(?:^|[^a-z0-9_])([a-z][a-z0-9+.-]{0,31})$/i
const SCHEME_WINDOW = 33
const USERINFO_MAX = 512

/**
 * URL 凭据脱敏：`scheme://user:token@host` → `scheme://***@host`。
 * http(s) 的任何 userinfo 都视为凭据（token 常单独出现）；其他 scheme 只在含 `:` 时脱敏，
 * 避免把 `ssh://git@host` 这类用户名也抹掉。Host 侧已脱敏，这里是兜底。
 * 只在每个 `://` 附近的小窗口里检查，整体线性（与 Host 侧 console.ts 同理，A1 合并前关口发现）。
 */
export function redactCredentials(text: string): string {
  let result = ''
  let copied = 0
  let from = 0
  for (;;) {
    const separator = text.indexOf('://', from)
    if (separator < 0) break
    const userinfoStart = separator + 3
    from = userinfoStart
    const windowStart = Math.max(0, separator - SCHEME_WINDOW)
    // 窗口从文本开头起算时，开头本身就是词边界。
    const head = (windowStart === 0 ? '' : ' ') + text.slice(windowStart, separator)
    const scheme = SCHEME_BEFORE_SEPARATOR.exec(head)?.[1]
    if (scheme === undefined) continue
    const at = userinfoEnd(text, userinfoStart)
    if (at < 0) continue
    const userinfo = text.slice(userinfoStart, at)
    const lower = scheme.toLowerCase()
    if (userinfo === '***' || !(lower === 'http' || lower === 'https' || userinfo.includes(':'))) continue
    result += `${text.slice(copied, userinfoStart)}***@`
    copied = at + 1
    from = copied
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/** userinfo 结束处 `@` 的下标；遇到空白、`/` 或超过上限则不是凭据，返回 -1。 */
function userinfoEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + USERINFO_MAX + 1)
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (char === '@') return index > start ? index : -1
    if (char === '/' || char === undefined || /\s/.test(char)) return -1
  }
  return -1
}

/** 单条输出按字符兜底截断到 64KB（Host 按字节截断，这里防御异常大的响应）。 */
export function clampOutput(text: string, max = CONSOLE_OUTPUT_MAX_BYTES): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** 对一条记录做客户端兜底：argv/stdout/stderr 脱敏，输出超限截断。 */
export function sanitizeRecord(record: ConsoleRecord): ConsoleRecord {
  const stdout = clampOutput(redactCredentials(record.stdout))
  const stderr = clampOutput(redactCredentials(record.stderr))
  return {
    ...record,
    argv: record.argv.map(redactCredentials),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: record.stdoutTruncated || stdout.truncated,
    stderrTruncated: record.stderrTruncated || stderr.truncated,
  }
}

/** 带值的 git 全局选项（`git -c k=v log` 中 `k=v` 不是子命令）。 */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** 把 argv 拆成全局选项、子命令与其余参数，用于高亮子命令。 */
export function splitArgv(argv: readonly string[]): { globals: string[]; subcommand: string | null; args: string[] } {
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('-')) break
    index += GLOBAL_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1
  }
  if (index >= argv.length) return { globals: [...argv], subcommand: null, args: [] }
  return {
    globals: argv.slice(0, index),
    subcommand: argv[index] ?? null,
    args: argv.slice(index + 1),
  }
}

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./^~-]+$/

/** 可粘贴到终端的命令：`git` + 按 POSIX 单引号转义的 argv。 */
export function formatCommand(argv: readonly string[]): string {
  const quote = (arg: string): string => {
    if (arg !== '' && SAFE_SHELL_WORD.test(arg)) return arg
    return `'${arg.replace(/'/g, `'\\''`)}'`
  }
  return ['git', ...argv.map(quote)].join(' ')
}

/** 耗时：<1s 用 ms，否则保留一位小数的秒。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** 本地时区 `HH:mm:ss.SSS`；非法输入原样返回。 */
export function formatRecordTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 失败：非 0 退出码、取消或超时。 */
export function isFailedRecord(record: ConsoleRecord): boolean {
  return record.exitCode !== 0 || record.cancelled === true || record.timedOut === true
}

/** 退出码列的文本。 */
export function exitLabel(record: ConsoleRecord): LocalizedText {
  if (record.timedOut === true) return text('console.exit.timeout')
  if (record.cancelled === true) return text('console.exit.cancelled')
  if (record.exitCode === null) return text('console.exit.unknown')
  return text('console.exit.code', { code: record.exitCode })
}

/** 折叠时的单行摘要：失败优先 stderr，否则 stdout 的首个非空行。 */
export function outputSummary(record: ConsoleRecord, max = 120): string {
  const pick = (text: string): string => text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  const preferred = isFailedRecord(record) ? pick(record.stderr) || pick(record.stdout) : pick(record.stdout) || pick(record.stderr)
  return preferred.length > max ? `${preferred.slice(0, max - 1)}…` : preferred
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  /** 稳定 key：时间 + argv + 耗时 + 退出码（重复时追加序号）。 */
  key: string
  /** 记录时间（ms），用于清空水位。 */
  atMs: number
  record: ConsoleRecord
  failed: boolean
}

interface Watermark { atMs: number; keys: ReadonlySet<string> }

export interface ConsoleState {
  /** 清空水位之后的可见记录，按时间从旧到新。 */
  entries: ConsoleEntry[]
  /** Host 环形缓冲是否丢过旧记录。 */
  hostTruncated: boolean
  loading: boolean
  error: GitError | null
  /** 暂停自动滚动。 */
  paused: boolean
  expanded: Readonly<Record<string, boolean>>
  /** 用户清空过视图（区分「从未有记录」与「已清空」）。 */
  cleared: boolean
  /** 可见记录中失败的条数。 */
  failedCount: number
  lastLoadedAt: number | null
}

export type ConsoleLoader = (signal: AbortSignal) => Promise<RpcResult<ConsoleValue>>

export interface ConsoleStoreOptions {
  load: ConsoleLoader
  intervalMs?: number
  /** 面板/抽屉是否可见；默认 document.visibilityState === 'visible'。 */
  isVisible?: () => boolean
  now?: () => number
}

export interface ConsoleStore {
  getState(): ConsoleState
  subscribe(listener: () => void): () => void
  /** 立即拉取一次（事件后拉取 / 打开抽屉时调用）。 */
  refresh(): Promise<void>
  /** 开始按间隔轮询（抽屉打开时）。 */
  start(): void
  /** 停止轮询并中止在途请求（抽屉关闭时）。 */
  stop(): void
  /** 页面可见性变化时转发给轮询器。 */
  notifyVisibleChange(): void
  /** 直接采用一份 console 响应（测试/外部推送）。 */
  apply(value: ConsoleValue): void
  /** 只清空客户端视图：记录水位，之后只显示更新的记录。 */
  clear(): void
  setPaused(paused: boolean): void
  toggleExpanded(key: string): void
  /** 切换会话：清空所有状态并停止轮询。 */
  reset(): void
}

const INITIAL: ConsoleState = {
  entries: [],
  hostTruncated: false,
  loading: false,
  error: null,
  paused: false,
  expanded: {},
  cleared: false,
  failedCount: 0,
  lastLoadedAt: null,
}

function toEntries(records: readonly ConsoleRecord[]): ConsoleEntry[] {
  const seen = new Map<string, number>()
  const entries = records.map((raw, index) => {
    const record = sanitizeRecord(raw)
    const parsed = Date.parse(record.at)
    const base = `${record.at}|${record.argv.join('\u0000')}|${record.durationMs}|${String(record.exitCode)}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return {
      entry: {
        key: count === 0 ? base : `${base}#${count}`,
        atMs: Number.isNaN(parsed) ? 0 : parsed,
        record,
        failed: isFailedRecord(record),
      },
      index,
    }
  })
  // 按时间从旧到新；同一时间保持 Host 顺序。
  entries.sort((a, b) => a.entry.atMs - b.entry.atMs || a.index - b.index)
  return entries.map(item => item.entry)
}

const afterWatermark = (entry: ConsoleEntry, watermark: Watermark | null): boolean =>
  watermark === null || entry.atMs > watermark.atMs || (entry.atMs === watermark.atMs && !watermark.keys.has(entry.key))

/** 创建控制台 store。 */
export function createConsoleStore(options: ConsoleStoreOptions): ConsoleStore {
  const listeners = new Set<() => void>()
  const now = options.now ?? Date.now
  let state: ConsoleState = INITIAL
  let all: ConsoleEntry[] = []
  let hostTruncated = false
  let watermark: Watermark | null = null
  let sequence = 0
  let controller: AbortController | undefined
  let poller: Poller | undefined

  const emit = (patch: Partial<ConsoleState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const project = (): Partial<ConsoleState> => {
    const entries = all.filter(entry => afterWatermark(entry, watermark))
    // 只保留仍可见记录的展开状态，避免无限增长。
    const visible = new Set(entries.map(entry => entry.key))
    const expanded: Record<string, boolean> = {}
    for (const [key, open] of Object.entries(state.expanded)) if (open && visible.has(key)) expanded[key] = true
    return {
      entries,
      expanded,
      hostTruncated,
      failedCount: entries.filter(entry => entry.failed).length,
    }
  }

  const apply = (value: ConsoleValue): void => {
    all = toEntries(value.records)
    hostTruncated = value.truncated
    emit({ ...project(), loading: false, error: null, lastLoadedAt: now() })
  }

  const fetchOnce = async (): Promise<{ version: number; result: RpcResult<ConsoleValue> }> => {
    const version = ++sequence
    controller?.abort()
    const current = new AbortController()
    controller = current
    if (state.entries.length === 0 && state.lastLoadedAt === null) emit({ loading: true })
    let result: RpcResult<ConsoleValue>
    try {
      result = await options.load(current.signal)
    } catch (error) {
      result = { ok: false, error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) } }
    }
    if (controller === current) controller = undefined
    return { version, result }
  }

  const accept = ({ version, result }: { version: number; result: RpcResult<ConsoleValue> }): void => {
    // 只采用最后一次发起的请求；被 stop/reset 作废的也丢弃。
    if (version !== sequence) return
    if (result.ok) apply(result.value)
    else emit({ loading: false, error: result.error })
  }

  const stopPolling = (): void => {
    poller?.stop()
    poller = undefined
    controller?.abort()
    controller = undefined
    sequence += 1
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => { accept(await fetchOnce()) },
    start: () => {
      if (poller !== undefined) return
      poller = createPoller({
        intervalMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        isVisible: options.isVisible ?? (() => globalThis.document?.visibilityState !== 'hidden'),
        refresh: fetchOnce,
        onResult: accept,
      })
      poller.start()
    },
    stop: stopPolling,
    notifyVisibleChange: () => poller?.notifyVisibleChange(),
    apply,
    clear: () => {
      const latest = all.reduce((max, entry) => Math.max(max, entry.atMs), Number.NEGATIVE_INFINITY)
      watermark = Number.isFinite(latest)
        ? { atMs: latest, keys: new Set(all.filter(entry => entry.atMs === latest).map(entry => entry.key)) }
        : watermark
      emit({ ...project(), cleared: true, expanded: {} })
    },
    setPaused: paused => { if (paused !== state.paused) emit({ paused }) },
    toggleExpanded: (key) => {
      const expanded = { ...state.expanded }
      if (expanded[key] === true) delete expanded[key]
      else expanded[key] = true
      emit({ expanded })
    },
    reset: () => {
      stopPolling()
      all = []
      hostTruncated = false
      watermark = null
      emit(INITIAL)
    },
  }
}

/** 把控制台 store 接进 React。 */
export function useConsoleState(store: ConsoleStore): ConsoleState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
