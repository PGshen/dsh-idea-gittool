// T5a：Client 侧轮询器单测。用假时钟覆盖可见时按间隔触发、不可见暂停、
// 串行不堆叠（dirty 补一次）、按 version 丢弃过期响应与错误恢复。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_POLL_INTERVAL_MS,
  createPoller,
  type PollResult,
} from '../../src/client/polling.ts'

interface Deferred {
  promise: Promise<PollResult>
  resolve: (result: PollResult) => void
  reject: (error: unknown) => void
}

function createDeferred(): Deferred {
  let resolve!: (result: PollResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PollResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createPoller 间隔与可见性', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('可见时先立即刷新，然后按间隔触发；stop 后不再触发', async () => {
    const refresh = vi.fn(async () => ({ version: 1 }))
    const poller = createPoller({ intervalMs: 1000, isVisible: () => true, refresh })

    poller.start()
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)

    poller.stop()
    const callsAtStop = refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledTimes(callsAtStop)
    expect(poller.getState().running).toBe(false)
  })

  it('不可见时 start 不刷新，变可见后立即刷新并恢复间隔', async () => {
    let visible = false
    const refresh = vi.fn(async () => ({ version: 1 }))
    const poller = createPoller({
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      isVisible: () => visible,
      refresh,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 3)
    expect(refresh).not.toHaveBeenCalled()

    visible = true
    poller.notifyVisibleChange()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(poller.getState().running).toBe(true)

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('运行中变为不可见时暂停计时，重新可见后继续', async () => {
    let visible = true
    const refresh = vi.fn(async () => ({ version: 1 }))
    const poller = createPoller({ intervalMs: 1000, isVisible: () => visible, refresh })

    poller.start()
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)

    visible = false
    poller.notifyVisibleChange()
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledTimes(2)

    visible = true
    poller.notifyVisibleChange()
    expect(refresh).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('用注入时钟记录 lastRunAt', async () => {
    let time = 1000
    const refresh = vi.fn(async () => ({ version: 1 }))
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      now: () => time,
    })

    poller.start()
    expect(poller.getState().lastRunAt).toBe(1000)

    time = 2500
    await vi.advanceTimersByTimeAsync(1000)
    expect(poller.getState().lastRunAt).toBe(2500)
    poller.stop()
  })

  it('onResult 收到 refresh 的完整返回值（泛型透传）', async () => {
    interface RefreshValue {
      version: number
      value: string
    }
    const received: RefreshValue[] = []
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh: async (): Promise<RefreshValue> => ({ version: 2, value: 'payload' }),
      onResult: (result) => {
        received.push(result)
      },
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toEqual([{ version: 2, value: 'payload' }])
    expect(poller.getState().version).toBe(2)
    poller.stop()
  })
})

describe('createPoller 串行不堆叠', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('进行中多次触发只标记 dirty，完成后补一次', async () => {
    const first = createDeferred()
    const refresh = vi
      .fn<() => Promise<PollResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ version: 2 })
    const poller = createPoller({ intervalMs: 1000, isVisible: () => true, refresh })

    poller.start()
    expect(refresh).toHaveBeenCalledTimes(1)

    // 进行中跨过多个间隔：不允许并发堆叠。
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(poller.getState().inFlight).toBe(true)
    expect(poller.getState().dirty).toBe(true)

    first.resolve({ version: 1 })
    await vi.advanceTimersByTimeAsync(0)

    // 刚好补一次，不会把积压的触发全部补跑。
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('手动 request 与定时触发共用串行队列', async () => {
    const first = createDeferred()
    const refresh = vi
      .fn<() => Promise<PollResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ version: 1 })
    const poller = createPoller({ intervalMs: 1000, isVisible: () => true, refresh })

    poller.start()
    poller.request()
    expect(refresh).toHaveBeenCalledTimes(1)

    first.resolve({ version: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('stop 之后到达的响应不回调', async () => {
    const first = createDeferred()
    const onResult = vi.fn()
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh: () => first.promise,
      onResult,
    })

    poller.start()
    poller.stop()
    first.resolve({ version: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(onResult).not.toHaveBeenCalled()
  })
})

describe('createPoller 按 version 丢弃过期响应', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('响应 version 小于外部观察到的 version 时丢弃，后续响应正常采用', async () => {
    const first = createDeferred()
    const onResult = vi.fn()
    const refresh = vi
      .fn<() => Promise<PollResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ version: 9 })
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      onResult,
    })

    poller.start()
    // 例如 bootstrap 先返回了更新的 version。
    poller.observeVersion(9)

    first.resolve({ version: 7 })
    await vi.advanceTimersByTimeAsync(0)
    expect(onResult).not.toHaveBeenCalled()
    expect(poller.getState().version).toBe(9)

    await vi.advanceTimersByTimeAsync(1000)
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ version: 9 })
    expect(poller.getState().version).toBe(9)
    poller.stop()
  })

  it('比已采用结果更旧的响应被丢弃，version 单调不回退', async () => {
    const refresh = vi
      .fn<() => Promise<PollResult>>()
      .mockResolvedValueOnce({ version: 5 })
      .mockResolvedValue({ version: 4 })
    const onResult = vi.fn()
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      onResult,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(poller.getState().version).toBe(5)

    await vi.advanceTimersByTimeAsync(1000)
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(poller.getState().version).toBe(5)
    poller.stop()
  })

  it('observeVersion 只接受更大的 version', () => {
    const poller = createPoller({ isVisible: () => true, refresh: async () => ({ version: 1 }) })

    poller.observeVersion(3)
    poller.observeVersion(2)
    poller.observeVersion(Number.NaN)

    expect(poller.getState().version).toBe(3)
    poller.stop()
  })
})

describe('createPoller 错误处理', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refresh 拒绝时调用 onError，并在下一个间隔继续', async () => {
    const onError = vi.fn()
    const refresh = vi
      .fn<() => Promise<PollResult>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ version: 1 })
    const onResult = vi.fn()
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      onError,
      onResult,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(poller.getState().inFlight).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('refresh 同步抛错也会被捕获', async () => {
    const onError = vi.fn()
    const refresh = vi.fn<() => Promise<PollResult>>(() => {
      throw new Error('sync boom')
    })
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      onError,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('onError 自身抛错不会产生未处理拒绝', async () => {
    const refresh = vi.fn<() => Promise<PollResult>>().mockRejectedValue(new Error('boom'))
    const onError = vi.fn(() => {
      throw new Error('handler boom')
    })
    const poller = createPoller({
      intervalMs: 1000,
      isVisible: () => true,
      refresh,
      onError,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    poller.stop()
  })
})
