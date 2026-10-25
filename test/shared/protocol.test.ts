import { describe, expect, it } from 'vitest'

import {
  CONSOLE_BUFFER_SIZE,
  CONSOLE_OUTPUT_MAX_BYTES,
  DIFF_FILE_MAX_BYTES,
  DIFF_FILE_MAX_LINES,
  DIFF_RESPONSE_MAX_BYTES,
  LOG_PAGE_MAX_LIMIT,
  RPC_CHANNEL,
  RPC_ENDPOINTS,
  isRpcResult,
} from '../../src/shared/protocol.ts'

describe('RPC 协议常量', () => {
  it('channel 是以 / 开头的绝对路径', () => {
    expect(RPC_CHANNEL.startsWith('/')).toBe(true)
    expect(RPC_CHANNEL).toBe('/dsh-git')
  })

  it('端点包含 A1 只读端点且不重复', () => {
    expect(new Set(RPC_ENDPOINTS).size).toBe(RPC_ENDPOINTS.length)
    expect([...RPC_ENDPOINTS]).toEqual(expect.arrayContaining([
      'bootstrap', 'status', 'log', 'branches', 'refs', 'commit', 'diff', 'console',
    ]))
  })

  it('A1 上限常量覆盖协议与设计约定', () => {
    expect(LOG_PAGE_MAX_LIMIT).toBe(200)
    expect(DIFF_FILE_MAX_BYTES).toBe(256 * 1024)
    expect(DIFF_FILE_MAX_LINES).toBe(5000)
    expect(DIFF_RESPONSE_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(CONSOLE_BUFFER_SIZE).toBe(200) // 设计 §12：最多 200 条
    expect(CONSOLE_OUTPUT_MAX_BYTES).toBe(64 * 1024)
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
