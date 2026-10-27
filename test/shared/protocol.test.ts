import { describe, expect, it } from 'vitest'

import {
  CONSOLE_BUFFER_SIZE,
  CONSOLE_OUTPUT_MAX_BYTES,
  DIFF_FILE_MAX_BYTES,
  DIFF_FILE_MAX_LINES,
  DIFF_RESPONSE_MAX_BYTES,
  LOG_PAGE_MAX_LIMIT,
  MERGE_CHUNK_STATES,
  MERGE_DRAFT_VERSION,
  RPC_CHANNEL,
  RPC_ENDPOINTS,
  WRITE_ENDPOINTS,
  isRpcResult,
  isWriteEndpoint,
  validDraftChunkRange,
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

describe('B2 历史端点', () => {
  it('blame 是读端点', () => {
    expect([...RPC_ENDPOINTS]).toContain('blame')
    expect(isWriteEndpoint('blame')).toBe(false)
  })
})

describe('B1 合并端点（T1 契约冻结）', () => {
  const B1_READ = ['mergeFile'] as const
  const B1_WRITE = ['mergeDraftSave', 'mergeApply', 'unresolveConflict'] as const

  it('登记读 1、写 3 个端点', () => {
    expect([...RPC_ENDPOINTS]).toEqual(expect.arrayContaining([...B1_READ, ...B1_WRITE]))
    expect([...WRITE_ENDPOINTS]).toEqual(expect.arrayContaining([...B1_WRITE]))
    for (const endpoint of B1_WRITE) expect(isWriteEndpoint(endpoint), endpoint).toBe(true)
    for (const endpoint of B1_READ) expect(isWriteEndpoint(endpoint), endpoint).toBe(false)
  })

  it('写端点是端点表的子集且不重复', () => {
    expect(new Set(WRITE_ENDPOINTS).size).toBe(WRITE_ENDPOINTS.length)
    for (const endpoint of WRITE_ENDPOINTS) expect(RPC_ENDPOINTS, endpoint).toContain(endpoint)
  })

  it('草稿与块状态的取值固定', () => {
    expect(MERGE_DRAFT_VERSION).toBe(1)
    expect([...MERGE_CHUNK_STATES]).toEqual([
      'pending', 'left', 'right', 'both-left-first', 'both-right-first', 'ignored', 'edited',
    ])
  })

  it('草稿块的行区间要么同时缺省，要么是有序的非负整数', () => {
    expect(validDraftChunkRange({})).toBe(true)
    expect(validDraftChunkRange({ resultStart: 0, resultEnd: 0 })).toBe(true)
    expect(validDraftChunkRange({ resultStart: 2, resultEnd: 5 })).toBe(true)
    for (const bad of [{ resultStart: 1 }, { resultEnd: 1 }, { resultStart: -1, resultEnd: 1 }, { resultStart: 0.5, resultEnd: 1 }, { resultStart: '0', resultEnd: 1 }, { resultStart: 3, resultEnd: 2 }]) {
      expect(validDraftChunkRange(bad)).toBe(false)
    }
  })
})
