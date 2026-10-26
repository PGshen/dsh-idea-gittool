import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import { GitCommandFailure, createGitRunner, instrumentGitRunner } from '../../src/host/git-executor.ts'
import { createGitConsole } from '../../src/host/console.ts'
import {
  canonicalPath,
  createTempRepo,
  delay,
  removeTempDir,
  writeExecutableScript,
} from './fixtures.ts'
import { createFakeSubprocess, lastSpawn } from './fake-subprocess.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo()
  cleanups.push(() => repo.cleanup())
  return repo
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-exec-'))
  cleanups.push(() => removeTempDir(dir))
  return dir
}

/** An executable that ignores its argv and sleeps, for timeout/cancel scenarios. */
function makeSlowExecutable(dir: string): string {
  return writeExecutableScript(dir, 'slow-git.sh', '#!/bin/sh\nsleep 5\n')
}

describe('createGitRunner', () => {
  it('spawns git with argv, cwd and the read-only environment', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const result = await run(['rev-parse', '--show-toplevel'], { cwd: repo.root })

    expect(result.exitCode).toBe(0)
    expect(canonicalPath(result.stdout.trim())).toBe(canonicalPath(repo.root))

    const spec = lastSpawn(fake)
    expect(spec.argv[0]).toBe('git')
    expect(spec.argv.slice(1)).toEqual(['rev-parse', '--show-toplevel'])
    expect(spec.cwd).toBe(repo.root)
    expect(spec.stdio.stdin).toBe('ignore')
    expect(spec.graceMs).toBe(2000)
    expect(spec.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
      LC_ALL: 'C',
    })
    expect(spec.env?.GIT_DIR).toBeUndefined()
  })

  it('clears inherited repository selectors such as GIT_DIR', async () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = '/nonexistent/git-dir'
    cleanups.push(() => {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    })
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const result = await run(['status', '--porcelain=v2', '--branch', '-z'], { cwd: repo.root })

    expect(result.exitCode).toBe(0)
    expect(lastSpawn(fake).env?.GIT_DIR).toBeUndefined()
  })

  it('returns the exit code instead of throwing for a failing command', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const result = await run(['rev-parse', '--verify', 'no-such-rev'], { cwd: repo.root })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('maps a spawn lookup failure to git/exec-failed', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    fake.resolveExecutable = async () => {
      throw new Error('git not found')
    }
    const run = createGitRunner(fake)

    await expect(run(['status'], { cwd: repo.root })).rejects.toMatchObject({
      code: 'git/exec-failed',
    })
  })

  it('refuses lossy output with git/output-too-large', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const failure: unknown = await run(['status', '--porcelain=v2', '--branch', '-z'], {
      cwd: repo.root,
      stdoutMaxBytes: 8,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GitCommandFailure)
    expect((failure as GitCommandFailure).code).toBe('git/output-too-large')
    expect((failure as GitCommandFailure).details).toMatchObject({ stdoutMaxBytes: 8 })
  })

  it('maps a deadline to git/timeout', async () => {
    const dir = makeTempDir()
    const fake = createFakeSubprocess({ executable: makeSlowExecutable(dir) })
    const run = createGitRunner(fake)

    await expect(run(['status'], { cwd: dir, timeoutMs: 50 })).rejects.toMatchObject({
      code: 'git/timeout',
      details: { timeoutMs: 50 },
    })
  })

  it('maps caller cancellation to git/exec-failed with a cancelled detail', async () => {
    const dir = makeTempDir()
    const fake = createFakeSubprocess({ executable: makeSlowExecutable(dir) })
    const run = createGitRunner(fake)
    const controller = new AbortController()

    const assertion = expect(
      run(['status'], { cwd: dir, timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'git/exec-failed',
      details: { cancelled: true },
    })
    await delay(60)
    controller.abort()
    await assertion
  })
})

describe('createGitRunner stdin (A3 T1)', () => {
  it('pipes a string to stdin and closes it', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const result = await run(['hash-object', '--stdin'], { cwd: repo.root, stdin: 'hello\n' })

    expect(result.exitCode).toBe(0)
    // `printf 'hello\n' | git hash-object --stdin`
    expect(result.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    const spec = lastSpawn(fake)
    expect(spec.stdio.stdin).toBe('pipe')
    expect(fake.spawns.at(-1)?.stdinWritten).toBe('hello\n')
  })

  it('pipes raw bytes (NUL-separated pathspecs survive)', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    const bytes = new TextEncoder().encode('a\0b\0')

    const result = await run(['hash-object', '--stdin'], { cwd: repo.root, stdin: bytes })

    expect(result.exitCode).toBe(0)
    expect(lastSpawn(fake).stdio.stdin).toBe('pipe')
    expect(fake.spawns.at(-1)?.stdinWritten).toBe('a\0b\0')
  })

  it('fails instead of running git on an empty stdin when the seam returns no stdin pipe', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.git('add', 'a.txt')
    const fake = createFakeSubprocess({ withholdStdin: true })
    const run = createGitRunner(fake)

    let failure: unknown
    try {
      await run(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: repo.root,
        mode: 'write',
        confine: { kind: 'unconfined' },
        stdin: 'a.txt\0',
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(GitCommandFailure)
    expect((failure as GitCommandFailure).code).toBe('git/exec-failed')
    // Empty pathspec would have unstaged the whole index; staging must be untouched.
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('a.txt')
  })

  it('keeps stdin ignored when no input is given', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    await createGitRunner(fake)(['rev-parse', 'HEAD'], { cwd: repo.root })
    expect(lastSpawn(fake).stdio.stdin).toBe('ignore')
  })

  it('passes stdin through a confined write command', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    const confine = {
      kind: 'confined' as const,
      wrap: async (argv: readonly string[]) => ['env', ...argv],
    }

    const result = await run(['hash-object', '--stdin'], { cwd: repo.root, mode: 'write', confine, stdin: 'hello\n' })

    expect(result.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    expect(lastSpawn(fake).argv[0]).toBe('env')
    expect(lastSpawn(fake).stdio.stdin).toBe('pipe')
  })
})

describe('instrumentGitRunner', () => {
  const fixedNow = () => Date.parse('2026-10-25T10:00:00.000Z')

  it('records one successful call with argv, duration, exit code and output', async () => {
    const repo = makeRepo()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(createGitRunner(createFakeSubprocess()), gitConsole)

    const result = await run(['rev-parse', '--show-toplevel'], { cwd: repo.root })

    expect(result.exitCode).toBe(0)
    const [record] = gitConsole.recent().records
    expect(record?.argv).toEqual(['rev-parse', '--show-toplevel'])
    expect(record?.exitCode).toBe(0)
    expect(typeof record?.durationMs).toBe('number')
    expect(record?.stdout.trim().length).toBeGreaterThan(0)
    expect(record?.at).toBe('2026-10-25T10:00:00.000Z')
  })

  it('records the stdin size but never its content', async () => {
    const repo = makeRepo()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(createGitRunner(createFakeSubprocess()), gitConsole)

    await run(['hash-object', '--stdin'], { cwd: repo.root, stdin: 'secret-path\0' })

    const [record] = gitConsole.recent().records
    expect(record?.stdinBytes).toBe(12)
    expect(JSON.stringify(record)).not.toContain('secret-path')
  })

  it('records non-zero exits as data instead of throwing', async () => {
    const repo = makeRepo()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(createGitRunner(createFakeSubprocess()), gitConsole)

    const result = await run(['rev-parse', '--verify', 'no-such-rev'], { cwd: repo.root })

    expect(result.exitCode).not.toBe(0)
    const [record] = gitConsole.recent().records
    expect(record?.exitCode).not.toBe(0)
    expect(record?.stderr.length).toBeGreaterThan(0)
  })

  it('records a timeout and rethrows the structured failure', async () => {
    const dir = makeTempDir()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(
      createGitRunner(createFakeSubprocess({ executable: makeSlowExecutable(dir) })),
      gitConsole,
    )

    await expect(run(['status'], { cwd: dir, timeoutMs: 50 })).rejects.toMatchObject({
      code: 'git/timeout',
    })

    const [record] = gitConsole.recent().records
    expect(record).toMatchObject({ exitCode: null, timedOut: true, argv: ['status'] })
  })

  it('records caller cancellation', async () => {
    const dir = makeTempDir()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(
      createGitRunner(createFakeSubprocess({ executable: makeSlowExecutable(dir) })),
      gitConsole,
    )
    const controller = new AbortController()

    const assertion = expect(
      run(['status'], { cwd: dir, timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'git/exec-failed', details: { cancelled: true } })
    await delay(60)
    controller.abort()
    await assertion

    const [record] = gitConsole.recent().records
    expect(record).toMatchObject({ cancelled: true, exitCode: null })
    expect(record?.timedOut).not.toBe(true)
  })

  it('marks a lossy stdout failure as truncated output', async () => {
    const repo = makeRepo()
    const gitConsole = createGitConsole({ now: fixedNow })
    const run = instrumentGitRunner(createGitRunner(createFakeSubprocess()), gitConsole)

    await expect(
      run(['status', '--porcelain=v2', '--branch', '-z'], { cwd: repo.root, stdoutMaxBytes: 8 }),
    ).rejects.toMatchObject({ code: 'git/output-too-large' })

    const [record] = gitConsole.recent().records
    expect(record).toMatchObject({ stdoutTruncated: true, exitCode: null })
  })
})
