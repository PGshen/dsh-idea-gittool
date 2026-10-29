// B4d T2: a missing git is `git/not-found`; a user-set git path is validated before the Host adopts
// it (in memory only, design decision 1) and every later command runs that program.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { createGitExecutable } from '../../src/host/git-executable.ts'
import { GIT_BINARY } from './git-binary.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

const SIGNAL = new AbortController().signal
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git exe ✓ '))
  dirs.push(dir)
  return dir
}

/** An executable shell script at `<scratch>/<name>`. */
function script(name: string, body: string, mode = 0o755): string {
  const path = join(scratch(), name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
  return path
}

async function failure(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

describe('git not found', () => {
  it('classifies a PATH without git as git/not-found', async () => {
    const fake = createFakeSubprocess({ executable: null })
    const run = createGitRunner(fake, { executable: createGitExecutable(fake) })

    const error = await failure(run(['--version'], { cwd: tmpdir() }))

    expect(error.code).toBe('git/not-found')
  })

  it('reports git/not-found from info() and recovers once git appears on PATH', async () => {
    const fake = createFakeSubprocess({ executable: null })
    const git = createGitExecutable(fake)

    expect((await failure(git.info(SIGNAL))).code).toBe('git/not-found')

    fake.executable = GIT_BINARY
    const info = await git.info(SIGNAL)
    expect(info).toMatchObject({ path: GIT_BINARY, source: 'path' })
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(info.raw).toMatch(/^git version /u)
  })

  it('probes --version once until the path changes', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)

    await git.info(SIGNAL)
    await git.info(SIGNAL)

    expect(fake.spawns.filter(spawn => spawn.spec.argv.includes('--version'))).toHaveLength(1)
  })
})

describe('setting the git path', () => {
  it.each([
    ['a relative path', () => 'bin/git', 'not-absolute'],
    ['a missing file', () => join(scratch(), 'nope', 'git'), 'not-found'],
    ['a file that is not executable', () => script('git', 'exit 0', 0o644), 'not-executable'],
    ['a program that is not git', () => script('git', 'echo hello'), 'not-git'],
  ])('rejects %s', async (_label, path, reason) => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)

    const error = await failure(git.set(path(), SIGNAL))

    expect(error.code).toBe('git/invalid-payload')
    expect(error.details).toMatchObject({ reason })
    expect(git.override()).toBeNull()
  })

  it('rejects a git older than the minimum with git/unsupported-version', async () => {
    const git = createGitExecutable(createFakeSubprocess())

    const error = await failure(git.set(script('git', 'echo "git version 2.20.1"'), SIGNAL))

    expect(error.code).toBe('git/unsupported-version')
    expect(error.details).toEqual({ current: '2.20.1', minimum: '2.25.0' })
    expect(git.override()).toBeNull()
  })

  it('adopts a valid path, and every command then runs it even without git on PATH', async () => {
    const fake = createFakeSubprocess({ executable: null })
    const git = createGitExecutable(fake)
    const run = createGitRunner(fake, { directBinary: true, executable: git })
    const wrapper = script('my git', `exec "${GIT_BINARY}" "$@"`)

    const info = await git.set(wrapper, SIGNAL)
    const result = await run(['rev-parse', '--git-dir'], { cwd: tmpdir() })

    expect(info).toMatchObject({ path: wrapper, source: 'setting' })
    expect(result.exitCode).not.toBeNull()
    expect(fake.spawns.at(-1)?.spec.argv[0]).toBe(wrapper)
  })

  it('goes back to PATH when the path is cleared', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    await git.set(script('git', `exec "${GIT_BINARY}" "$@"`), SIGNAL)

    const info = await git.set(null, SIGNAL)

    expect(info).toMatchObject({ path: GIT_BINARY, source: 'path' })
    expect(git.override()).toBeNull()
  })

  it('reports git/not-found when an adopted path disappears', async () => {
    const fake = createFakeSubprocess({ executable: null })
    const git = createGitExecutable(fake)
    const run = createGitRunner(fake, { executable: git })
    const wrapper = script('git', `exec "${GIT_BINARY}" "$@"`)
    await git.set(wrapper, SIGNAL)
    rmSync(wrapper)

    expect((await failure(run(['--version'], { cwd: tmpdir() }))).code).toBe('git/not-found')
  })
})
