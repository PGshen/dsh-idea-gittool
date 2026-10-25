import { describe, expect, it } from 'vitest'

import { CONSOLE_BUFFER_SIZE, CONSOLE_OUTPUT_MAX_BYTES } from '../../src/shared/protocol.ts'
import {
  createGitConsole,
  redactCredentials,
  truncateConsoleOutput,
} from '../../src/host/console.ts'

describe('redactCredentials', () => {
  it('replaces the userinfo part of an http URL with ***', () => {
    expect(redactCredentials('https://alice:ghp_secret@github.com/o/r.git')).toBe(
      'https://***@github.com/o/r.git',
    )
  })

  it('redacts ssh URLs with an explicit port', () => {
    expect(redactCredentials('ssh://git:secret@example.com:2222/repo.git')).toBe(
      'ssh://***@example.com:2222/repo.git',
    )
  })

  it('redacts a user-only URL', () => {
    expect(redactCredentials('https://token@example.com/x')).toBe('https://***@example.com/x')
  })

  it('redacts every occurrence in one string', () => {
    expect(
      redactCredentials('fetch https://a:b@one.example/x and https://c:d@two.example/y'),
    ).toBe('fetch https://***@one.example/x and https://***@two.example/y')
  })

  it('leaves scp-style remotes and plain text untouched', () => {
    expect(redactCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
    expect(redactCredentials('author <a@b.c>')).toBe('author <a@b.c>')
  })
})

describe('truncateConsoleOutput', () => {
  it('keeps short output unchanged', () => {
    expect(truncateConsoleOutput('hello')).toEqual({ text: 'hello', truncated: false })
  })

  it('keeps the prefix within the byte budget and flags the cut', () => {
    const output = 'x'.repeat(CONSOLE_OUTPUT_MAX_BYTES + 10)

    const truncated = truncateConsoleOutput(output)

    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(CONSOLE_OUTPUT_MAX_BYTES)
    expect(truncated.text.startsWith('xxx')).toBe(true)
  })

  it('never splits a multi-byte character', () => {
    const output = '你'.repeat(CONSOLE_OUTPUT_MAX_BYTES)

    const truncated = truncateConsoleOutput(output)

    expect(truncated.truncated).toBe(true)
    expect(truncated.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(CONSOLE_OUTPUT_MAX_BYTES)
  })
})

describe('createGitConsole', () => {
  const now = () => Date.parse('2026-10-25T10:00:00.000Z')

  it('stamps records with the injected clock and keeps one record per call', () => {
    const gitConsole = createGitConsole({ now })

    gitConsole.record({
      argv: ['status', '--porcelain=v2'],
      durationMs: 12,
      exitCode: 0,
      stdout: 'out',
      stderr: '',
    })

    const value = gitConsole.recent()
    expect(value.truncated).toBe(false)
    expect(value.records).toHaveLength(1)
    expect(value.records[0]).toMatchObject({
      at: '2026-10-25T10:00:00.000Z',
      argv: ['status', '--porcelain=v2'],
      durationMs: 12,
      exitCode: 0,
      stdout: 'out',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  })

  it('keeps a ring buffer and reports dropped history', () => {
    const gitConsole = createGitConsole({ now })
    for (let index = 0; index < CONSOLE_BUFFER_SIZE + 3; index += 1) {
      gitConsole.record({
        argv: ['log', `--skip=${String(index)}`],
        durationMs: index,
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
    }

    const value = gitConsole.recent()

    expect(value.records).toHaveLength(CONSOLE_BUFFER_SIZE)
    expect(value.truncated).toBe(true)
    expect(value.records[0]?.argv).toEqual(['log', `--skip=3`])
    expect(value.records.at(-1)?.argv).toEqual(['log', `--skip=${String(CONSOLE_BUFFER_SIZE + 2)}`])
  })

  it('truncates each stream independently and remembers which one was cut', () => {
    const gitConsole = createGitConsole({ now })

    gitConsole.record({
      argv: ['diff'],
      durationMs: 1,
      exitCode: 0,
      stdout: 'o'.repeat(CONSOLE_OUTPUT_MAX_BYTES + 5),
      stderr: 'e'.repeat(CONSOLE_OUTPUT_MAX_BYTES + 5),
    })

    const record = gitConsole.recent().records[0]
    expect(record?.stdoutTruncated).toBe(true)
    expect(record?.stderrTruncated).toBe(true)
    expect(record?.stdout).toHaveLength(CONSOLE_OUTPUT_MAX_BYTES)
    expect(record?.stderr).toHaveLength(CONSOLE_OUTPUT_MAX_BYTES)
  })

  it('redacts credentials in argv and captured output', () => {
    const gitConsole = createGitConsole({ now })

    gitConsole.record({
      argv: ['fetch', 'https://alice:token@example.com/o/r.git'],
      durationMs: 1,
      exitCode: 0,
      stdout: 'remote: https://alice:token@example.com/o/r.git',
      stderr: 'fatal: https://alice:token@example.com/o/r.git',
    })

    const record = gitConsole.recent().records[0]
    expect(record?.argv).toEqual(['fetch', 'https://***@example.com/o/r.git'])
    expect(record?.stdout).toBe('remote: https://***@example.com/o/r.git')
    expect(record?.stderr).toBe('fatal: https://***@example.com/o/r.git')
  })

  it('preserves cancelled and timed-out markers and null exit codes', () => {
    const gitConsole = createGitConsole({ now })

    gitConsole.record({
      argv: ['status'],
      durationMs: 50,
      exitCode: null,
      stdout: '',
      stderr: 'git command exceeded 50 ms',
      timedOut: true,
    })

    expect(gitConsole.recent().records[0]).toMatchObject({
      exitCode: null,
      timedOut: true,
    })
  })

  it('returns a defensive copy of the record list', () => {
    const gitConsole = createGitConsole({ now })
    gitConsole.record({ argv: ['status'], durationMs: 1, exitCode: 0, stdout: '', stderr: '' })

    gitConsole.recent().records.pop()

    expect(gitConsole.recent().records).toHaveLength(1)
  })
})
