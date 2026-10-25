import { describe, expect, it } from 'vitest'

import { createBootstrapCache } from '../../src/client/bootstrap-cache.ts'
import type { GitClient } from '../../src/client/git-client.ts'
import type {
  BootstrapValue,
  GitErrorCode,
  LogValue,
  RpcResult,
  StatusValue,
} from '../../src/shared/protocol.ts'

function bootstrapValue(version: number, branch = 'main'): BootstrapValue {
  return {
    sessionId: 's1',
    repoRoot: '/repo',
    status: {
      branch,
      detached: false,
      head: 'a'.repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      operation: null,
      truncated: false,
    },
    log: { commits: [], truncated: false },
    writePolicy: { mode: 'read-write' },
    version,
  }
}

const okBootstrap = (value: BootstrapValue): RpcResult<BootstrapValue> => ({ ok: true, value })
const fail = <T>(code: GitErrorCode, message: string): RpcResult<T> => ({ ok: false, error: { code, message } })

function fakeClient(reply: (sessionId: string) => Promise<RpcResult<BootstrapValue>>): {
  client: GitClient
  calls: () => number
} {
  let count = 0
  const unused = async <T>(): Promise<RpcResult<T>> => fail<T>('git/exec-failed', 'unused')
  return {
    calls: () => count,
    client: {
      bootstrap: (sessionId) => {
        count += 1
        return reply(sessionId)
      },
      status: (): Promise<RpcResult<StatusValue>> => unused(),
      log: (): Promise<RpcResult<LogValue>> => unused(),
    },
  }
}

describe('bootstrap 快照缓存', () => {
  it('同一会话并发只发一次请求并通知订阅者', async () => {
    const { client, calls } = fakeClient(async () => okBootstrap(bootstrapValue(1)))
    const cache = createBootstrapCache(client)
    const seen: string[] = []
    const unsubscribe = cache.subscribe('s1', () => { seen.push(cache.get('s1')?.status?.branch ?? 'none') })
    cache.ensure('s1')
    cache.ensure('s1')
    await cache.refresh('s1')
    expect(calls()).toBe(1)
    expect(seen).toContain('main')
    unsubscribe()
  })

  it('更旧的 version 不覆盖已有快照', async () => {
    let next: RpcResult<BootstrapValue> = okBootstrap(bootstrapValue(2))
    const { client } = fakeClient(async () => next)
    const cache = createBootstrapCache(client)
    await cache.refresh('s1')
    expect(cache.get('s1')?.version).toBe(2)
    next = okBootstrap(bootstrapValue(1, 'old'))
    await cache.refresh('s1')
    expect(cache.get('s1')?.status?.branch).toBe('main')
  })

  it('失败记录在 getFailure，成功后清空', async () => {
    let next: RpcResult<BootstrapValue> = fail<BootstrapValue>('git/no-session', 'no session')
    const { client } = fakeClient(async () => next)
    const cache = createBootstrapCache(client)
    await cache.refresh('s1')
    expect(cache.getFailure('s1')?.code).toBe('git/no-session')
    next = okBootstrap(bootstrapValue(3))
    await cache.refresh('s1')
    expect(cache.getFailure('s1')).toBeNull()
    expect(cache.get('s1')?.version).toBe(3)
  })
})
