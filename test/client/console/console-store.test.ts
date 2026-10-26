// T8 控制台数据层：脱敏、截断、argv 拆分、命令复制格式、清空水位、展开/暂停、轮询与过期丢弃。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import { render } from '../../../src/client/localized-text.ts'
import type { ConsoleValue, RpcResult } from '../../../src/shared/protocol.ts'
import { CONSOLE_OUTPUT_MAX_BYTES } from '../../../src/shared/protocol.ts'
import {
  clampOutput,
  createConsoleStore,
  exitLabel,
  formatCommand,
  formatDuration,
  isFailedRecord,
  outputSummary,
  redactCredentials,
  sanitizeRecord,
  splitArgv,
} from '../../../src/client/console/console-store.ts'
import { failedRecord, record } from './console-fixtures.ts'

const ok = (records = [record()], truncated = false): RpcResult<ConsoleValue> => ({ ok: true, value: { records, truncated } })

describe('redactCredentials', () => {
  it('https 的 user:token 与单独 token 都脱敏', () => {
    expect(redactCredentials('https://alice:ghp_secret@github.com/a/b.git')).toBe('https://***@github.com/a/b.git')
    expect(redactCredentials('fetch https://ghp_token@example.com/r')).toBe('fetch https://***@example.com/r')
  })

  it('ssh 只有用户名时保留，带密码时脱敏', () => {
    expect(redactCredentials('ssh://git@github.com/a/b.git')).toBe('ssh://git@github.com/a/b.git')
    expect(redactCredentials('ssh://u:pw@host/r')).toBe('ssh://***@host/r')
  })

  it('同一文本多处都替换，已脱敏的保持不变', () => {
    expect(redactCredentials('a https://u:p@h1 b HTTP://x:y@h2')).toBe('a https://***@h1 b HTTP://***@h2')
    expect(redactCredentials('https://***@h')).toBe('https://***@h')
    expect(redactCredentials('no url here')).toBe('no url here')
  })
})

describe('sanitizeRecord / clampOutput', () => {
  it('argv、stdout、stderr 全部脱敏', () => {
    const sanitized = sanitizeRecord(record({
      argv: ['push', 'https://u:t@host/r.git'],
      stdout: 'To https://u:t@host/r.git',
      stderr: 'remote: https://u:t@host',
    }))
    expect(sanitized.argv).toEqual(['push', 'https://***@host/r.git'])
    expect(sanitized.stdout).toBe('To https://***@host/r.git')
    expect(sanitized.stderr).toBe('remote: https://***@host')
  })

  it('超过 64KB 的输出兜底截断并打标记；Host 的截断标记保留', () => {
    const big = 'x'.repeat(CONSOLE_OUTPUT_MAX_BYTES + 10)
    expect(clampOutput(big)).toEqual({ text: 'x'.repeat(CONSOLE_OUTPUT_MAX_BYTES), truncated: true })
    const sanitized = sanitizeRecord(record({ stdout: big, stderrTruncated: true }))
    expect(sanitized.stdoutTruncated).toBe(true)
    expect(sanitized.stderrTruncated).toBe(true)
  })
})

describe('argv 展示', () => {
  it('splitArgv 跳过带值的全局选项找出子命令', () => {
    expect(splitArgv(['-c', 'core.quotepath=off', 'log', '-n', '1'])).toEqual({
      globals: ['-c', 'core.quotepath=off'],
      subcommand: 'log',
      args: ['-n', '1'],
    })
    expect(splitArgv(['--no-pager', 'status'])).toEqual({ globals: ['--no-pager'], subcommand: 'status', args: [] })
    expect(splitArgv(['--version'])).toEqual({ globals: ['--version'], subcommand: null, args: [] })
  })

  it('formatCommand 只给需要的参数加引号', () => {
    expect(formatCommand(['log', '--format=%H', '-n', '1'])).toBe('git log --format=%H -n 1')
    expect(formatCommand(['commit', '-m', "it's done"])).toBe(`git commit -m 'it'\\''s done'`)
    expect(formatCommand(['log', ''])).toBe(`git log ''`)
  })

  it('耗时、退出码、失败判定与摘要', () => {
    expect(formatDuration(42)).toBe('42 ms')
    expect(formatDuration(1500)).toBe('1.5 s')
    expect(isFailedRecord(record())).toBe(false)
    expect(isFailedRecord(failedRecord())).toBe(true)
    expect(isFailedRecord(record({ exitCode: null, timedOut: true }))).toBe(true)
    expect(render(zhT, exitLabel(failedRecord()))).toBe('退出码 128')
    expect(render(zhT, exitLabel(record({ exitCode: null, timedOut: true })))).toBe('超时')
    expect(render(zhT, exitLabel(record({ exitCode: null, cancelled: true })))).toBe('已取消')
    expect(outputSummary(failedRecord())).toBe('fatal: Needed a single revision')
    expect(outputSummary(record())).toBe('aaa111')
  })
})

describe('createConsoleStore', () => {
  afterEach(() => { vi.useRealTimers() })

  it('refresh 采用响应，按时间从旧到新排序并统计失败', async () => {
    const store = createConsoleStore({ load: async () => ok([failedRecord(), record()]), now: () => 99 })
    await store.refresh()
    const state = store.getState()
    expect(state.entries.map(entry => entry.record.argv.at(-1))).toEqual(['100', 'nope'])
    expect(state.failedCount).toBe(1)
    expect(state.lastLoadedAt).toBe(99)
    expect(state.loading).toBe(false)
  })

  it('同一时间同一命令的重复记录 key 不冲突', () => {
    const store = createConsoleStore({ load: async () => ok() })
    store.apply({ records: [record(), record()], truncated: true })
    const keys = store.getState().entries.map(entry => entry.key)
    expect(new Set(keys).size).toBe(2)
    expect(store.getState().hostTruncated).toBe(true)
  })

  it('失败响应写 error，后续成功清空', async () => {
    let next: RpcResult<ConsoleValue> = { ok: false, error: { code: 'git/no-session', message: 'x' } }
    const store = createConsoleStore({ load: async () => next })
    await store.refresh()
    expect(store.getState().error?.code).toBe('git/no-session')
    next = ok()
    await store.refresh()
    expect(store.getState().error).toBeNull()
  })

  it('loader 抛错收敛成 git/exec-failed', async () => {
    const store = createConsoleStore({ load: async () => { throw new Error('boom') } })
    await store.refresh()
    expect(store.getState().error).toEqual({ code: 'git/exec-failed', message: 'boom' })
  })

  it('clear 只清客户端视图：水位之前的记录不再出现，新记录照常显示', () => {
    const store = createConsoleStore({ load: async () => ok() })
    const first = record()
    store.apply({ records: [first], truncated: false })
    store.clear()
    expect(store.getState().entries).toEqual([])
    expect(store.getState().cleared).toBe(true)
    // Host 仍返回旧记录 + 一条同毫秒的新记录 + 一条更新的记录。
    const sameMs = record({ argv: ['status'] })
    const later = failedRecord()
    store.apply({ records: [first, sameMs, later], truncated: false })
    expect(store.getState().entries.map(entry => entry.record.argv[0])).toEqual(['status', 'rev-parse'])
    expect(store.getState().failedCount).toBe(1)
  })

  it('展开/暂停状态切换并通知订阅者', () => {
    const store = createConsoleStore({ load: async () => ok() })
    store.apply({ records: [record()], truncated: false })
    const listener = vi.fn()
    store.subscribe(listener)
    const key = store.getState().entries[0]?.key ?? ''
    store.toggleExpanded(key)
    expect(store.getState().expanded[key]).toBe(true)
    store.toggleExpanded(key)
    expect(store.getState().expanded[key]).toBeUndefined()
    store.setPaused(true)
    store.setPaused(true)
    expect(store.getState().paused).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('迟到的旧请求被丢弃，只采用最后一次', async () => {
    const resolvers: Array<(value: RpcResult<ConsoleValue>) => void> = []
    const store = createConsoleStore({ load: () => new Promise(resolve => resolvers.push(resolve)) })
    const first = store.refresh()
    const second = store.refresh()
    resolvers[1]?.(ok([record({ argv: ['status'] })]))
    resolvers[0]?.(ok([record({ argv: ['log'] })]))
    await Promise.all([first, second])
    expect(store.getState().entries.map(entry => entry.record.argv[0])).toEqual(['status'])
  })

  it('start 按间隔轮询并传入 signal，stop 中止在途请求', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const load = vi.fn(async (signal: AbortSignal) => { signals.push(signal); return ok() })
    const store = createConsoleStore({ load, intervalMs: 1000, isVisible: () => true })
    store.start()
    store.start()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.getState().entries).toHaveLength(1)
    store.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reset 清空记录、水位与轮询', async () => {
    const store = createConsoleStore({ load: async () => ok() })
    await store.refresh()
    store.clear()
    store.reset()
    expect(store.getState().entries).toEqual([])
    expect(store.getState().cleared).toBe(false)
    store.apply({ records: [record()], truncated: false })
    expect(store.getState().entries).toHaveLength(1)
  })
})

describe('客户端兜底脱敏保持线性（A1 合并前关口发现）', () => {
  it.each([
    ['连续字母', 'o'.repeat(2 * 1024 * 1024)],
    ['每个字符都是词边界', 'o-'.repeat(1024 * 1024)],
    ['有协议头但 userinfo 不结束', `https://${'u'.repeat(2 * 1024 * 1024)}`],
  ])('2MB 的%s在 200ms 内完成', (_label, text) => {
    const startedAt = performance.now()
    redactCredentials(text)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })
})
