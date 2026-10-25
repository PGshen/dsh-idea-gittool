import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
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
