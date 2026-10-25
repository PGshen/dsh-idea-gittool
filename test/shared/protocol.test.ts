import { describe, expect, it } from 'vitest'

import { RPC_CHANNEL, RPC_ENDPOINTS, isRpcResult } from '../../src/shared/protocol.ts'

describe('RPC 协议常量', () => {
  it('channel 是以 / 开头的绝对路径', () => {
    expect(RPC_CHANNEL.startsWith('/')).toBe(true)
    expect(RPC_CHANNEL).toBe('/dsh-git')
  })

  it('端点包含 bootstrap / status / log 且不重复', () => {
    expect(new Set(RPC_ENDPOINTS).size).toBe(RPC_ENDPOINTS.length)
    expect([...RPC_ENDPOINTS]).toEqual(expect.arrayContaining(['bootstrap', 'status', 'log']))
  })

  it('isRpcResult 只接受带 ok 判别字段的信封', () => {
    expect(isRpcResult({ ok: true, value: 1 })).toBe(true)
    expect(isRpcResult({ ok: false, error: { code: 'git/no-session', message: 'x' } })).toBe(true)
    expect(isRpcResult(null)).toBe(false)
    expect(isRpcResult({ value: 1 })).toBe(false)
    expect(isRpcResult({ ok: true })).toBe(false)
    expect(isRpcResult({ ok: false })).toBe(false)
  })
})
