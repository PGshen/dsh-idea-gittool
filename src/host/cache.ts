// Host 侧每仓库根的内存缓存：版本号单调递增，条目带写入时的 version。
// 刷新链路（watch → rpc）用 version 判断「这份数据是否已经过期」；
// 纯内存、可注入时钟，便于假时钟测试 TTL，不触碰文件系统。

/** 一条缓存记录。 */
export interface CacheEntry<T> {
  value: T
  /** 写入时的仓库 version；与当前 version 不一致即视为过期。 */
  version: number
  /** 写入时刻（毫秒），由注入时钟提供。 */
  storedAt: number
}

export interface RepoCacheOptions {
  /** 可注入时钟，默认 Date.now；用于 storedAt 与 TTL。 */
  now?: () => number
  /** 条目存活时间（毫秒）；缺省或 0 表示只按 version / invalidate 失效。 */
  ttlMs?: number
}

/** 每仓库根一个单调 version + 带 version 的键值缓存。 */
export interface RepoCache {
  /** 当前 version；从未 bump 过的仓库根返回 0。 */
  versionOf: (repoRoot: string) => number
  /** 单调 +1 并返回新值；旧条目因 version 不匹配而整体失效。 */
  bumpVersion: (repoRoot: string) => number
  /** 读取当前 version 下的值；version 不匹配或 TTL 过期时返回 undefined 并顺手清理。 */
  get: <T = unknown>(repoRoot: string, key: string) => T | undefined
  /**
   * 写入当前 version 下的值。
   * 传了 expectedVersion 且与当前 version 不一致时拒绝写入并返回 false，
   * 避免慢请求覆盖新版本的数据。
   */
  set: <T>(repoRoot: string, key: string, value: T, expectedVersion?: number) => boolean
  /** 删除单个键；不传 key 时删除该仓库根的全部条目。version 保持不变。 */
  invalidate: (repoRoot: string, key?: string) => void
  /** 清空所有仓库根的版本与条目（插件关闭或测试时用）。 */
  clear: () => void
}

/**
 * 创建纯内存缓存。所有读写都不抛错，未知仓库根按 version 0 处理。
 *
 * 用法（T5b 接线示例）：
 * ```ts
 * const cache = createRepoCache()
 * const version = cache.versionOf(repoRoot)
 * if (!cache.get(repoRoot, 'status')) cache.set(repoRoot, 'status', status, version)
 * // watch 信号到达时：cache.bumpVersion(repoRoot)
 * ```
 */
export function createRepoCache(options: RepoCacheOptions = {}): RepoCache {
  const { now = Date.now, ttlMs = 0 } = options
  const versions = new Map<string, number>()
  const entries = new Map<string, Map<string, CacheEntry<unknown>>>()

  const versionOf = (repoRoot: string): number => versions.get(repoRoot) ?? 0

  const isExpired = (entry: CacheEntry<unknown>): boolean =>
    ttlMs > 0 && now() - entry.storedAt >= ttlMs

  const dropEntryMapIfEmpty = (repoRoot: string, map: Map<string, CacheEntry<unknown>>): void => {
    if (map.size === 0) entries.delete(repoRoot)
  }

  const get = <T = unknown>(repoRoot: string, key: string): T | undefined => {
    const map = entries.get(repoRoot)
    if (!map) return undefined
    const entry = map.get(key)
    if (!entry) return undefined
    if (entry.version !== versionOf(repoRoot) || isExpired(entry)) {
      map.delete(key)
      dropEntryMapIfEmpty(repoRoot, map)
      return undefined
    }
    return entry.value as T
  }

  const set = <T>(repoRoot: string, key: string, value: T, expectedVersion?: number): boolean => {
    const current = versionOf(repoRoot)
    if (expectedVersion !== undefined && expectedVersion !== current) return false
    let map = entries.get(repoRoot)
    if (!map) {
      map = new Map()
      entries.set(repoRoot, map)
    }
    map.set(key, { value, version: current, storedAt: now() })
    return true
  }

  const invalidate = (repoRoot: string, key?: string): void => {
    if (key === undefined) {
      entries.delete(repoRoot)
      return
    }
    const map = entries.get(repoRoot)
    if (!map) return
    map.delete(key)
    dropEntryMapIfEmpty(repoRoot, map)
  }

  const bumpVersion = (repoRoot: string): number => {
    const next = versionOf(repoRoot) + 1
    versions.set(repoRoot, next)
    return next
  }

  const clear = (): void => {
    versions.clear()
    entries.clear()
  }

  return { versionOf, bumpVersion, get, set, invalidate, clear }
}
