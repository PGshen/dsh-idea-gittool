// Client 侧轮询器：面板可见时按固定间隔刷新，不可见时暂停。
// 纯 TypeScript、不依赖 React；定时器与时钟可被假时钟测试接管。
// 串行执行：进行中只标记 dirty，完成后补跑一次，绝不并发堆叠。
// 过期响应按 Host 的仓库 version 丢弃（BootstrapValue.version，协议 §9）。

/** 轮询间隔默认值：可见时 3s 一次（产品设计 §16，调研 §9 兜底 2）。 */
export const DEFAULT_POLL_INTERVAL_MS = 3000

/** 一次刷新结果，至少携带 Host 的仓库 version。 */
export interface PollResult {
  version: number
}

export interface PollerOptions<T extends PollResult = PollResult> {
  /** 轮询间隔（毫秒），默认 3000。 */
  intervalMs?: number
  /** 面板当前是否可见；通常读 `document.visibilityState === 'visible'`。 */
  isVisible: () => boolean
  /** 拉取一次数据；返回的 version 用于丢弃过期响应。可同步返回。 */
  refresh: () => Promise<T> | T
  /** 可注入时钟，默认 Date.now；只用于记录 lastRunAt。 */
  now?: () => number
  /** 每次采用（未被丢弃）结果后回调，result 是 refresh 的完整返回值。 */
  onResult?: (result: T) => void
  /** refresh 抛错时回调；不传则静默忽略，轮询继续。 */
  onError?: (error: unknown) => void
}

/** 调试/测试用的状态快照。 */
export interface PollerState {
  running: boolean
  inFlight: boolean
  /** 有触发被进行中的请求吞掉，完成后需补一次。 */
  dirty: boolean
  /** 已采用的最大 version；更旧的响应会被丢弃。 */
  version: number
  lastRunAt: number | null
}

export interface Poller {
  /** 开始轮询：可见时立即刷新一次，然后按间隔触发；不可见时只登记、不排计时器。 */
  start: () => void
  /** 停止轮询；之后到达的响应不再回调。 */
  stop: () => void
  /** 处理 visibilitychange：不可见则清计时器，可见则立即刷新并恢复间隔。 */
  notifyVisibleChange: () => void
  /** 手动请求一次刷新；与定时触发共用串行队列（进行中则标记 dirty）。 */
  request: () => void
  /** 外部（如 bootstrap 响应）报告更大的 version，用于丢弃更旧的响应。 */
  observeVersion: (version: number) => void
  /** 当前状态快照。 */
  getState: () => PollerState
}

/**
 * 创建轮询器。泛型 T 是 refresh 的完整返回值（必须含 version），onResult 原样收到它。
 * 典型接线（T5b / Client tab 侧）：
 * ```ts
 * const poller = createPoller({
 *   isVisible: () => document.visibilityState === 'visible',
 *   refresh: async () => {
 *     const result = await gitClient.status({ sessionId })
 *     return { version: result.version, status: result.status }
 *   },
 *   onResult: ({ status }) => store.apply(status),
 *   onError: (error) => store.markRefreshFailed(error),
 * })
 * poller.start()
 * document.addEventListener('visibilitychange', () => poller.notifyVisibleChange())
 * // bootstrap 返回后：poller.observeVersion(bootstrap.version)
 * ```
 */
export function createPoller<T extends PollResult = PollResult>(
  options: PollerOptions<T>,
): Poller {
  const {
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    isVisible,
    refresh,
    now = Date.now,
    onResult,
    onError,
  } = options
  const interval = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : DEFAULT_POLL_INTERVAL_MS

  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let dirty = false
  let version = 0
  let lastRunAt: number | null = null

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const reportError = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // onError 自身的错误不能再冒泡成未处理拒绝。
    }
  }

  const deliver = (result: T): void => {
    try {
      onResult?.(result)
    } catch (error) {
      reportError(error)
    }
  }

  const schedule = (): void => {
    clearTimer()
    if (!running || !isVisible()) return
    timer = setTimeout(() => {
      timer = undefined
      run()
    }, interval)
  }

  const run = (): void => {
    if (!running || !isVisible()) return
    if (inFlight) {
      // 串行：进行中的请求吞掉这次触发，完成后补跑一次。
      dirty = true
      return
    }
    inFlight = true
    dirty = false
    lastRunAt = now()
    clearTimer()
    // 间隔从上一次开始计时：请求慢时期间仍会触发，但只会把 dirty 置位。
    schedule()
    const startedAtVersion = version

    void (async () => {
      try {
        const result = await refresh()
        if (!running) return
        // version 更旧：响应在飞行途中已经过期（例如 bootstrap 先返回了新版本）。
        if (result.version < version || result.version < startedAtVersion) return
        version = Math.max(version, result.version)
        deliver(result)
      } catch (error) {
        reportError(error)
      } finally {
        inFlight = false
        if (running && dirty) {
          dirty = false
          // 补一次；run() 会重新排下一个间隔。不可见时等 visibilitychange 再触发。
          if (isVisible()) run()
        }
      }
    })()
  }

  const start = (): void => {
    if (running) return
    running = true
    dirty = false
    if (isVisible()) run()
    else clearTimer()
  }

  const stop = (): void => {
    running = false
    dirty = false
    clearTimer()
  }

  const notifyVisibleChange = (): void => {
    if (!running) return
    if (!isVisible()) {
      clearTimer()
      return
    }
    if (inFlight) {
      dirty = true
      return
    }
    run()
  }

  const request = (): void => {
    if (!running) return
    if (!isVisible()) {
      dirty = true
      clearTimer()
      return
    }
    run()
  }

  const observeVersion = (next: number): void => {
    if (Number.isFinite(next) && next > version) version = next
  }

  const getState = (): PollerState => ({ running, inFlight, dirty, version, lastRunAt })

  return { start, stop, notifyVisibleChange, request, observeVersion, getState }
}
