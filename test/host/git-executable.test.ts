// B4d T2: a missing git is `git/not-found`; a user-set git path is validated before the Host adopts
// it (in memory only, design decision 1) and every later command runs that program.
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
    const wrapper = script('git', `exec "${GIT_BINARY}" "$@"`)

    const info = await git.set(wrapper, SIGNAL)
    const result = await run(['rev-parse', '--git-dir'], { cwd: tmpdir() })

    // Adopted by its real path, so a symlink swapped later cannot redirect it (final review I1).
    expect(info).toMatchObject({ path: realpathSync(wrapper), source: 'setting' })
    expect(result.exitCode).not.toBeNull()
    expect(fake.spawns.at(-1)?.spec.argv[0]).toBe(realpathSync(wrapper))
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

describe('which programs may become git (final review I1)', () => {
  const versionSpawns = (fake: ReturnType<typeof createFakeSubprocess>): number =>
    fake.spawns.filter(spawn => spawn.spec.argv.includes('--version')).length

  it('refuses a program not named git without running it', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)

    const error = await failure(git.set(script('tool', 'echo "git version 2.50.0"'), SIGNAL))

    expect(error.details).toMatchObject({ reason: 'not-git' })
    expect(versionSpawns(fake)).toBe(0)
  })

  it('refuses a git inside the session workspace without running it', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    const planted = script('git', 'echo "git version 2.50.0"')

    const error = await failure(git.set(planted, SIGNAL, { forbiddenRoots: [dirname(planted)] }))

    expect(error.details).toMatchObject({ reason: 'inside-workspace' })
    expect(versionSpawns(fake)).toBe(0)
    expect(git.override()).toBeNull()
  })

  it('judges the real file behind a symlink named git', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    const real = script('tool', 'echo "git version 2.50.0"')
    const link = join(scratch(), 'git')
    symlinkSync(real, link)

    expect((await failure(git.set(link, SIGNAL))).details).toMatchObject({ reason: 'not-git' })
  })

  it('refuses a UNC path on Windows', async () => {
    const git = createGitExecutable(createFakeSubprocess(), { platform: 'win32' })

    expect((await failure(git.set('\\\\server\\share\\git.exe', SIGNAL))).details).toMatchObject({ reason: 'not-local' })
  })

  it('stops running an adopted git once the file is replaced', async () => {
    const fake = createFakeSubprocess({ executable: null })
    const git = createGitExecutable(fake)
    const run = createGitRunner(fake, { executable: git })
    const wrapper = script('git', `exec "${GIT_BINARY}" "$@"`)
    await git.set(wrapper, SIGNAL)
    rmSync(wrapper)
    writeFileSync(wrapper, '#!/bin/sh\necho swapped\n')
    chmodSync(wrapper, 0o755)

    expect((await failure(run(['--version'], { cwd: tmpdir() }))).code).toBe('git/not-found')
  })

  it('does not fail a shared probe for everyone when its first caller aborts (final review M3)', async () => {
    const git = createGitExecutable(createFakeSubprocess())
    const first = new AbortController()

    const firstCall = git.info(first.signal)
    const second = git.info(SIGNAL)
    first.abort()

    await expect(firstCall).rejects.toBeDefined()
    expect((await second).source).toBe('path')
  })
})

// T1-T4 (B4d final review minor): `info()` and `set()` called concurrently, as several sessions and
// the client's mount-time re-send do.
describe('concurrent probing and setting', () => {
  const versionSpawns = (fake: ReturnType<typeof createFakeSubprocess>): number =>
    fake.spawns.filter(spawn => spawn.spec.argv.includes('--version')).length

  it('shares one --version probe among concurrent info() callers', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)

    const results = await Promise.all(Array.from({ length: 5 }, () => git.info(SIGNAL)))

    expect(versionSpawns(fake)).toBe(1)
    for (const info of results) expect(info).toEqual(results[0])
  })

  it('answers info() with the newly set git even while a PATH probe is still in flight', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    const wrapper = script('git', `exec "${GIT_BINARY}" "$@"`)

    const early = git.info(SIGNAL)
    const adopted = await git.set(wrapper, SIGNAL)

    expect((await early).source).toBe('path')
    expect(await git.info(SIGNAL)).toEqual(adopted)
    expect(git.override()).toBe(realpathSync(wrapper))
  })

  it('lets the latest set() win when an earlier one finishes validating later', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    const slow = script('git', 'sleep 1; echo "git version 2.40.0"')
    const fast = script('git', 'echo "git version 2.41.0"')

    const first = git.set(slow, SIGNAL)
    const second = git.set(fast, SIGNAL)
    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second])

    expect(secondOutcome).toMatchObject({ status: 'fulfilled', value: { path: realpathSync(fast) } })
    // The superseded call does not report success for a path that is not in effect.
    expect(firstOutcome.status).toBe('rejected')
    expect(git.override()).toBe(realpathSync(fast))
    expect(await git.info(SIGNAL)).toMatchObject({ path: realpathSync(fast), version: '2.41.0' })
  })

  it('stays on PATH when clearing the path overtakes a set() still validating', async () => {
    const fake = createFakeSubprocess()
    const git = createGitExecutable(fake)
    const slow = script('git', 'sleep 1; echo "git version 2.40.0"')

    const first = git.set(slow, SIGNAL)
    const cleared = await git.set(null, SIGNAL)
    const [firstOutcome] = await Promise.allSettled([first])

    expect(cleared.source).toBe('path')
    expect(firstOutcome.status).toBe('rejected')
    expect(git.override()).toBeNull()
    expect((await git.info(SIGNAL)).source).toBe('path')
  })
})

