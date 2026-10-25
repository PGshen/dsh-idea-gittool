// T8 控制台测试共用的 ConsoleRecord 样例（只放数据）。
import type { ConsoleRecord } from '../../../src/shared/protocol.ts'

export function record(overrides: Partial<ConsoleRecord> = {}): ConsoleRecord {
  return {
    at: '2026-10-25T04:03:09.120Z',
    argv: ['-c', 'core.quotepath=off', 'log', '--format=%H', '-n', '100'],
    durationMs: 42,
    exitCode: 0,
    stdout: 'aaa111\nbbb222\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

export const failedRecord = (): ConsoleRecord => record({
  at: '2026-10-25T04:03:10.000Z',
  argv: ['rev-parse', '--verify', 'nope'],
  exitCode: 128,
  stdout: '',
  stderr: 'fatal: Needed a single revision\n',
  durationMs: 1500,
})
