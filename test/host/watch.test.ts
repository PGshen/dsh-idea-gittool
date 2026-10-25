// T5a：Host 侧刷新模块的单测。覆盖 .git watch 目标计算、250ms 防抖合并、
// watch 降级，以及每仓库单调 version 的缓存（cache.ts 的测试也放在本文件，
// 避免占用计划之外的写作用域）。
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRepoCache } from '../../src/host/cache.ts'
import {
  DEFAULT_DEBOUNCE_MS,
  fsWatchFromService,
  gitWatchTargets,
  watchRepo,
  type FsWatch,
  type WatchFailure,
  type WatchSignal,
} from '../../src/host/watch.ts'

const ROOT = join('/tmp', 'dsh-git-watch-test', 'repo')

/** 取数组元素并让类型收窄（tsconfig 开了 noUncheckedIndexedAccess）。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`列表缺少下标 ${index}`)
  return value
}

interface FakeWatchOptions {
  /** 同步抛错的目标。 */
  throwOn?: readonly string[]
  /** 返回被拒绝 Promise（异步初始化失败）的目标。 */
  rejectOn?: readonly string[]
}

interface FakeWatch {
  fsWatch: FsWatch
  fire: (target: string) => void
  closed: string[]
  subscribed: string[]
}

function createFakeWatch(options: FakeWatchOptions = {}): FakeWatch {
  const callbacks = new Map<string, () => void>()
  const closed: string[] = []
  const subscribed: string[] = []

  const fsWatch: FsWatch = (target, onEvent) => {
    if (options.throwOn?.includes(target)) throw new Error(`watch 失败：${target}`)
    if (options.rejectOn?.includes(target)) {
      return Promise.reject(new Error(`watch 异步初始化失败：${target}`))
    }
    callbacks.set(target, onEvent)
    subscribed.push(target)
    return {
      close: () => {
        closed.push(target)
      },
    }
  }

  return {
    fsWatch,
    closed,
    subscribed,
    fire: (target) => {
      const callback = callbacks.get(target)
      if (!callback) throw new Error(`没有为 ${target} 建立 watch`)
      callback()
    },
  }
}

describe('gitWatchTargets', () => {
  it('返回 .git 下六个固定目标，全部位于仓库根的 .git 内', () => {
    const targets = gitWatchTargets(ROOT)

    expect(targets).toEqual([
      join(ROOT, '.git', 'HEAD'),
      join(ROOT, '.git', 'index'),
      join(ROOT, '.git', 'packed-refs'),
      join(ROOT, '.git', 'refs'),
      join(ROOT, '.git', 'refs', 'heads'),
      join(ROOT, '.git', 'refs', 'remotes'),
    ])
    expect(new Set(targets).size).toBe(targets.length)
    for (const target of targets) {
      expect(target.startsWith(join(ROOT, '.git'))).toBe(true)
    }
  })

  it('是纯函数：同一输入返回相同结果，不依赖文件系统状态', () => {
    expect(gitWatchTargets(ROOT)).toEqual(gitWatchTargets(ROOT))
    expect(gitWatchTargets(join(ROOT, 'other'))[0]).toBe(join(ROOT, 'other', '.git', 'HEAD'))
  })
})

describe('watchRepo 防抖与关闭', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('250ms 窗口内多次事件只合并触发一次，并携带触发过的目标', () => {
    const fake = createFakeWatch()
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch })
    const targets = gitWatchTargets(ROOT)

    fake.fire(at(targets, 0))
    vi.advanceTimersByTime(100)
    fake.fire(at(targets, 1))
    vi.advanceTimersByTime(100)
    fake.fire(at(targets, 4))

    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS - 1)
    expect(onChange).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0].targets).toEqual(
      [at(targets, 0), at(targets, 1), at(targets, 4)].sort(),
    )
  })

  it('不同防抖窗口分别触发', () => {
    const fake = createFakeWatch()
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch })
    const targets = gitWatchTargets(ROOT)

    fake.fire(at(targets, 0))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    fake.fire(at(targets, 1))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[0]?.[0].targets).toEqual([at(targets, 0)])
    expect(onChange.mock.calls[1]?.[0].targets).toEqual([at(targets, 1)])
  })

  it('close 取消未到期的防抖并释放全部 watch，重复 close 安全', async () => {
    const fake = createFakeWatch()
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    const watch = watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch })

    fake.fire(at(gitWatchTargets(ROOT), 0))
    await watch.close()
    await watch.close()
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS * 4)

    expect(onChange).not.toHaveBeenCalled()
    expect(fake.closed).toHaveLength(gitWatchTargets(ROOT).length)
    expect(fake.closed).toEqual(gitWatchTargets(ROOT))
  })

  it('onChange 抛错不会打断后续监听', () => {
    const fake = createFakeWatch()
    const onChange = vi.fn(() => {
      throw new Error('调用方错误')
    })
    watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch })
    const targets = gitWatchTargets(ROOT)

    fake.fire(at(targets, 0))
    expect(() => vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)).not.toThrow()
    fake.fire(at(targets, 1))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)

    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('用注入时钟填充信号的 at 字段', () => {
    const fake = createFakeWatch()
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch, now: () => 12_345 })

    fake.fire(at(gitWatchTargets(ROOT), 0))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)

    expect(onChange.mock.calls[0]?.[0].at).toBe(12_345)
  })
})

describe('watchRepo 降级', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('没有注入 watch 实现时标记降级且不抛错', async () => {
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    const watch = watchRepo({ root: ROOT, onChange })

    expect(watch.degraded).toBe(true)
    expect(watch.failures.map((failure: WatchFailure) => failure.code)).toContain(
      'watch-unavailable',
    )
    expect(watch.targets).toEqual([])
    await watch.ready
    await watch.close()
  })

  it('单个目标同步抛错只让该目标失败，其余目标继续工作', async () => {
    const indexTarget = join(ROOT, '.git', 'index')
    const fake = createFakeWatch({ throwOn: [indexTarget] })
    const onChange = vi.fn<(signal: WatchSignal) => void>()
    const watch = watchRepo({ root: ROOT, onChange, fsWatch: fake.fsWatch })

    expect(watch.degraded).toBe(true)
    expect(watch.failures).toHaveLength(1)
    expect(watch.failures[0]).toMatchObject({ target: indexTarget, code: 'watch-threw' })
    expect(watch.targets).toHaveLength(gitWatchTargets(ROOT).length - 1)

    fake.fire(at(gitWatchTargets(ROOT), 0))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    expect(onChange).toHaveBeenCalledTimes(1)

    await watch.ready
    await watch.close()
  })

  it('异步初始化失败时 ready 仍 resolve，并更新降级状态与回调', async () => {
    const indexTarget = join(ROOT, '.git', 'index')
    const fake = createFakeWatch({ rejectOn: [indexTarget] })
    const onDegraded = vi.fn<(failures: readonly WatchFailure[]) => void>()
    const watch = watchRepo({
      root: ROOT,
      onChange: vi.fn(),
      fsWatch: fake.fsWatch,
      onDegraded,
    })

    await expect(watch.ready).resolves.toBeUndefined()
    expect(watch.degraded).toBe(true)
    expect(watch.failures).toHaveLength(1)
    expect(watch.failures[0]).toMatchObject({ target: indexTarget, code: 'watch-threw' })
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(watch.targets).toHaveLength(gitWatchTargets(ROOT).length - 1)

    await watch.close()
  })

  it('异步 watch 在 close 之后才初始化完成时立即释放', async () => {
    const resolvers: Array<(handle: { close: () => void }) => void> = []
    const closed: string[] = []
    const fsWatch: FsWatch = () => {
      return new Promise((resolve) => {
        resolvers.push(resolve)
      })
    }
    const watch = watchRepo({ root: ROOT, onChange: vi.fn(), fsWatch })
    await watch.close()

    for (const resolve of resolvers) resolve({ close: () => closed.push('late') })
    await watch.ready
    await Promise.resolve()

    expect(closed).toHaveLength(resolvers.length)
    expect(closed.every((entry) => entry === 'late')).toBe(true)
  })
})

describe('仓库缓存（cache.ts）', () => {
  it('version 按仓库根独立且单调递增', () => {
    const cache = createRepoCache()

    expect(cache.versionOf('/a')).toBe(0)
    expect(cache.versionOf('/b')).toBe(0)
    expect(cache.bumpVersion('/a')).toBe(1)
    expect(cache.bumpVersion('/a')).toBe(2)
    expect(cache.bumpVersion('/b')).toBe(1)
    expect(cache.versionOf('/a')).toBe(2)
  })

  it('version 提升后旧条目自动失效', () => {
    const cache = createRepoCache()
    cache.set('/a', 'status', { branch: 'main' })

    expect(cache.get('/a', 'status')).toEqual({ branch: 'main' })

    cache.bumpVersion('/a')

    expect(cache.get('/a', 'status')).toBeUndefined()
  })

  it('invalidate 删除单个键或整个仓库，且不改变 version', () => {
    const cache = createRepoCache()
    cache.set('/a', 'status', 1)
    cache.set('/a', 'log', 2)
    cache.set('/b', 'status', 3)

    cache.invalidate('/a', 'status')
    expect(cache.get('/a', 'status')).toBeUndefined()
    expect(cache.get('/a', 'log')).toBe(2)

    cache.invalidate('/a')
    expect(cache.get('/a', 'log')).toBeUndefined()
    expect(cache.get('/b', 'status')).toBe(3)

    expect(cache.versionOf('/a')).toBe(0)
    expect(cache.bumpVersion('/a')).toBe(1)
  })

  it('带过期 version 的写入被拒绝，不会污染新版本', () => {
    const cache = createRepoCache()

    expect(cache.set('/a', 'status', 'v0', 0)).toBe(true)
    expect(cache.get('/a', 'status')).toBe('v0')

    cache.bumpVersion('/a')

    expect(cache.set('/a', 'status', 'stale', 0)).toBe(false)
    expect(cache.get('/a', 'status')).toBeUndefined()
  })

  it('按注入时钟做 TTL 过期；缺省 TTL 只按 version 失效', () => {
    let time = 0
    const cache = createRepoCache({ now: () => time, ttlMs: 1000 })
    cache.set('/a', 'log', ['x'])

    time = 999
    expect(cache.get('/a', 'log')).toEqual(['x'])

    time = 1000
    expect(cache.get('/a', 'log')).toBeUndefined()

    const forever = createRepoCache({ now: () => time })
    forever.set('/a', 'log', ['y'])
    time = 1_000_000
    expect(forever.get('/a', 'log')).toEqual(['y'])
  })

  it('clear 清空所有仓库的版本与条目', () => {
    const cache = createRepoCache()
    cache.set('/a', 'status', 1)
    cache.bumpVersion('/a')

    cache.clear()

    expect(cache.get('/a', 'status')).toBeUndefined()
    expect(cache.versionOf('/a')).toBe(0)
  })
})

describe('fsWatchFromService（ctx.fs 适配）', () => {
  interface FakeTarget { targetKey: string; displayPath: string }

  function fakeFs() {
    const resolved: string[] = []
    const watched: FakeTarget[] = []
    const listeners: Array<(error?: Error) => void> = []
    let closed = 0
    return {
      resolved, watched, listeners, closed: () => closed,
      service: {
        resolve: async (path: string): Promise<FakeTarget> => {
          resolved.push(path)
          return { targetKey: `key:${path}`, displayPath: path }
        },
        watch: async (target: FakeTarget, changed: (error?: Error) => void, signal: AbortSignal) => {
          signal.throwIfAborted()
          watched.push(target)
          listeners.push(changed)
          return async () => { closed += 1 }
        },
      },
    }
  }

  it('先 resolve 成 FsTarget 再 watch，变化回调转成 onEvent，close 透传', async () => {
    const fs = fakeFs()
    const watch = fsWatchFromService(fs.service, new AbortController().signal)
    const events: number[] = []

    const handle = await watch('/repo/.git/HEAD', () => events.push(1))

    expect(fs.resolved).toEqual(['/repo/.git/HEAD'])
    expect(fs.watched).toEqual([{ targetKey: 'key:/repo/.git/HEAD', displayPath: '/repo/.git/HEAD' }])
    at(fs.listeners, 0)()
    expect(events).toEqual([1])
    await (typeof handle === 'function' ? handle() : handle.close())
    expect(fs.closed()).toBe(1)
  })

  it('watcher 报错时也当作一次变化（宁可多刷新一次）', async () => {
    const fs = fakeFs()
    const watch = fsWatchFromService(fs.service, new AbortController().signal)
    const events: number[] = []
    await watch('/repo/.git/index', () => events.push(1))

    at(fs.listeners, 0)(new Error('overflow'))

    expect(events).toEqual([1])
  })

  it('provider 不支持 watch 时 reject，交给 watchRepo 降级', async () => {
    const service = {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      watch: async () => { throw new Error('Filesystem watching is not supported by this provider.') },
    }
    const watch = fsWatchFromService(service, new AbortController().signal)

    await expect(watch('/repo/.git/HEAD', () => {})).rejects.toThrow('not supported')
  })
})
