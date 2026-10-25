// 每个会话一份 bootstrap 快照：Git tab 与文档动作共用，避免重复请求。
// 只保存最新 version 的快照，旧响应直接丢弃（协议 §9）。
import type { BootstrapValue, GitError } from '../shared/protocol.ts'
import type { GitClient } from './git-client.ts'

export interface BootstrapCache {
  get(sessionId: string): BootstrapValue | null
  /** 最近一次失败；成功后清空。 */
  getFailure(sessionId: string): GitError | null
  /** 订阅某会话的快照变化；返回取消订阅。 */
  subscribe(sessionId: string, listener: () => void): () => void
  /** 有则跳过：同一会话同时只有一个请求在飞。 */
  ensure(sessionId: string): void
  /** 强制刷新，返回采用后的 version（失败时为当前 version）。 */
  refresh(sessionId: string): Promise<number>
}

export function createBootstrapCache(client: Pick<GitClient, 'bootstrap'>): BootstrapCache {
  const values = new Map<string, BootstrapValue>()
  const failures = new Map<string, GitError>()
  const listeners = new Map<string, Set<() => void>>()
  const inflight = new Map<string, Promise<number>>()

  const notify = (sessionId: string): void => {
    for (const listener of [...(listeners.get(sessionId) ?? [])]) listener()
  }

  const load = (sessionId: string): Promise<number> => {
    const running = inflight.get(sessionId)
    if (running !== undefined) return running
    const request = client.bootstrap(sessionId).then((result) => {
      if (result.ok) {
        const previous = values.get(sessionId)
        if (previous !== undefined && result.value.version < previous.version) return previous.version
        values.set(sessionId, result.value)
        failures.delete(sessionId)
        notify(sessionId)
        return result.value.version
      }
      failures.set(sessionId, result.error)
      notify(sessionId)
      return values.get(sessionId)?.version ?? 0
    }).finally(() => {
      inflight.delete(sessionId)
    })
    inflight.set(sessionId, request)
    return request
  }

  return {
    get: sessionId => values.get(sessionId) ?? null,
    getFailure: sessionId => failures.get(sessionId) ?? null,
    subscribe(sessionId, listener) {
      const bucket = listeners.get(sessionId) ?? new Set<() => void>()
      bucket.add(listener)
      listeners.set(sessionId, bucket)
      return () => {
        bucket.delete(listener)
        if (bucket.size === 0) listeners.delete(sessionId)
      }
    },
    ensure: (sessionId) => {
      void load(sessionId)
    },
    refresh: sessionId => load(sessionId),
  }
}
