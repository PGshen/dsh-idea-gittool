import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitRunner } from '../../src/host/git-executor.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { parseStatusPorcelainV2Z, readStatus } from '../../src/host/git/status.ts'
import { canonicalPath, createTempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(options: { initialCommit?: boolean } = {}): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo(options)
  cleanups.push(() => repo.cleanup())
  return repo
}

function makeRunner(): { run: GitRunner; fake: ReturnType<typeof createFakeSubprocess> } {
  const fake = createFakeSubprocess()
  return { run: createGitRunner(fake), fake }
}

describe('parseStatusPorcelainV2Z', () => {
  it('parses branch headers, staged/unstaged splits, renames, conflicts and untracked', () => {
    const head = 'a'.repeat(40)
    const records = [
      `# branch.oid ${head}`,
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aaa bbb file one.txt',
      '1 .M N... 100644 100644 100644 aaa bbb file two.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? untracked dir/file.txt',
      '1 .M N... 100644 100644 100644 aaa bbb file with space.txt',
    ]

    const status = parseStatusPorcelainV2Z(`${records.join('\0')}\0`)

    expect(status.head).toBe(head)
    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)

    expect(status.staged.map((entry) => entry.path)).toEqual(['file one.txt', 'new name.txt'])
    expect(status.staged[1]).toMatchObject({ status: 'R', origPath: 'old name.txt' })
    expect(status.unstaged.map((entry) => entry.path)).toEqual([
      'file two.txt',
      'file with space.txt',
    ])
    expect(status.unstaged[0]?.status).toBe('M')
    expect(status.conflicts).toEqual([{ path: 'conflict.txt', status: 'U' }])
    expect(status.untracked).toEqual([{ path: 'untracked dir/file.txt', status: '?' }])
    expect(status.operation).toBeNull()
    expect(status.truncated).toBe(false)
  })

  it('reports an initial branch with no commits', () => {
    const status = parseStatusPorcelainV2Z(
      ['# branch.oid (initial)', '# branch.head main'].join('\0'),
    )

    expect(status.head).toBeNull()
    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.operation).toBeNull()
  })

  it('reports a detached head', () => {
    const status = parseStatusPorcelainV2Z(
      [`# branch.oid ${'b'.repeat(40)}`, '# branch.head (detached)'].join('\0'),
    )

    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
  })

  it('carries the caller-detected operation and truncation flag through', () => {
    const status = parseStatusPorcelainV2Z(
      ['# branch.oid (initial)', '# branch.head main'].join('\0'),
      { operation: 'merge', truncated: true },
    )

    expect(status.operation).toBe('merge')
    expect(status.truncated).toBe(true)
  })

  it('marks output truncated once the entry limit is reached', () => {
    const records = [
      '# branch.oid (initial)',
      '# branch.head main',
      '? one.txt',
      '? two.txt',
      '? three.txt',
    ]

    const status = parseStatusPorcelainV2Z(`${records.join('\0')}\0`, { entryLimit: 2 })

    expect(status.untracked).toHaveLength(2)
    expect(status.truncated).toBe(true)
  })

  it('rejects an unparseable record instead of returning partial data', () => {
    expect(() => parseStatusPorcelainV2Z('1 M. broken\0')).toThrowError(GitCommandFailure)
  })
})

describe('readStatus', () => {
  it('returns structured status for staged, unstaged, renamed and untracked files', async () => {
    const repo = makeRepo()
    repo.write('tracked.txt', 'one\n')
    repo.write('rename-me.txt', 'x\n')
    repo.commit('setup')

    repo.write('tracked.txt', 'two\n')
    repo.git('add', 'tracked.txt')
    repo.write('README.md', '# changed\n')
    repo.write('untracked.txt', 'u\n')
    repo.git('mv', 'rename-me.txt', 'renamed.txt')

    const { run } = makeRunner()
    const status = await readStatus(run, repo.root)

    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.head).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect(status.upstream).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.conflicts).toEqual([])
    expect(status.operation).toBeNull()
    expect(status.truncated).toBe(false)

    expect(status.staged.map((entry) => entry.path).sort()).toEqual(['renamed.txt', 'tracked.txt'])
    const renamed = status.staged.find((entry) => entry.path === 'renamed.txt')
    expect(renamed).toMatchObject({ status: 'R', origPath: 'rename-me.txt' })
    expect(status.unstaged).toEqual([{ path: 'README.md', status: 'M' }])
    expect(status.untracked).toEqual([{ path: 'untracked.txt', status: '?' }])
  })

  it('reports upstream ahead and behind counts', async () => {
    const repo = makeRepo()
    repo.write('base.txt', 'base\n')
    repo.commit('second')
    repo.git('branch', 'base', 'HEAD')
    repo.write('main.txt', 'main\n')
    repo.commit('third')
    repo.git('checkout', 'base')
    repo.write('base-branch.txt', 'base branch\n')
    repo.commit('base branch commit')
    repo.git('checkout', 'main')
    repo.git('branch', '--set-upstream-to=base', 'main')

    const { run } = makeRunner()
    const status = await readStatus(run, repo.root)

    expect(status.upstream).toBe('base')
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
  })

  it('reports a detached head', async () => {
    const repo = makeRepo()
    repo.git('checkout', '--detach', 'HEAD')
    const { run } = makeRunner()

    const status = await readStatus(run, repo.root)

    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
    expect(status.head).toBe(repo.git('rev-parse', 'HEAD').trim())
  })

  it('reports unmerged conflicts and the in-progress merge operation', async () => {
    const repo = makeRepo()
    repo.write('conflict.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-b', 'other')
    repo.write('conflict.txt', 'other\n')
    repo.commit('other')
    repo.git('checkout', 'main')
    repo.write('conflict.txt', 'main\n')
    repo.commit('main')
    const merge = repo.gitResult('merge', 'other')
    expect(merge.status).not.toBe(0)

    const { run } = makeRunner()
    const status = await readStatus(run, repo.root)

    expect(status.conflicts.map((entry) => entry.path)).toEqual(['conflict.txt'])
    expect(status.conflicts[0]?.status).toBe('U')
    expect(status.operation).toBe('merge')
  })

  it('returns an empty status for a repository without commits', async () => {
    const repo = makeRepo({ initialCommit: false })
    const { run } = makeRunner()

    const status = await readStatus(run, repo.root)

    expect(status.head).toBeNull()
    expect(status.branch).toBe('main')
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.conflicts).toEqual([])
    expect(status.truncated).toBe(false)
  })

  it('marks truncated when the entry limit is exceeded', async () => {
    const repo = makeRepo()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) repo.write(name, `${name}\n`)
    const { run } = makeRunner()

    const status = await readStatus(run, repo.root, { entryLimit: 2 })

    expect(status.untracked).toHaveLength(2)
    expect(status.truncated).toBe(true)
  })

  it('does not swallow runner failures', async () => {
    const run: GitRunner = async () => {
      throw new GitCommandFailure('git/timeout', 'git status timed out', { timeoutMs: 8000 })
    }

    await expect(readStatus(run, '/tmp')).rejects.toMatchObject({ code: 'git/timeout' })
  })

  it('maps a non-zero exit to git/not-a-repository with stderr details', async () => {
    const run: GitRunner = async () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    })

    const failure: unknown = await readStatus(run, '/tmp').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GitCommandFailure)
    expect((failure as GitCommandFailure).code).toBe('git/not-a-repository')
    expect((failure as GitCommandFailure).details).toMatchObject({ exitCode: 128 })
  })

  it('runs porcelain v2 with -z in the given directory', async () => {
    const repo = makeRepo()
    const { run, fake } = makeRunner()

    await readStatus(run, repo.root)

    const last = fake.spawns.at(-1)
    expect(last?.spec.cwd).toBe(repo.root)
    expect(last?.spec.argv[0]).toBe('git')
    expect(last?.spec.argv).toContain('--porcelain=v2')
    expect(last?.spec.argv).toContain('-z')
    expect(last?.spec.argv).toContain('--branch')
  })

  it('keeps a subdirectory cwd inside the same repository', async () => {
    const repo = makeRepo()
    repo.write('sub/nested.txt', 'nested\n')
    repo.commit('nested')
    const { run } = makeRunner()

    const status = await readStatus(run, canonicalPath(join(repo.root, 'sub')))

    expect(status.branch).toBe('main')
  })
})
