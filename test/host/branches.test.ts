import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import type { GitRunner } from '../../src/host/git-executor.ts'
import { createGitRunner } from '../../src/host/git-executor.ts'
import { readBranches } from '../../src/host/git/branches.ts'
import { createTempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { GIT_BINARY } from './git-binary.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo({ initialCommit: false })
  cleanups.push(() => repo.cleanup())
  return repo
}

function makeRunner(): { run: GitRunner; fake: ReturnType<typeof createFakeSubprocess> } {
  const fake = createFakeSubprocess()
  return { run: createGitRunner(fake), fake }
}

/**
 * main: c1 → c2; feature/x branched at c1 with c3; c4 lands on main afterwards.
 * origin/main tracks c2, so main is ahead 1 / behind 0.
 */
function seed(repo: ReturnType<typeof createTempRepo>): {
  c1: string
  c2: string
  c3: string
  c4: string
} {
  repo.write('a.txt', 'one\n')
  const c1 = repo.commit('c1')
  repo.write('a.txt', 'two\n')
  const c2 = repo.commit('c2')
  repo.git('checkout', '-q', '-b', 'feature/x', c1)
  repo.write('feature.txt', 'feature\n')
  const c3 = repo.commit('c3')
  repo.git('checkout', '-q', 'main')
  repo.write('a.txt', 'three\n')
  const c4 = repo.commit('c4')

  repo.git('update-ref', 'refs/remotes/origin/main', c2)
  // Upstream tracking only resolves through a configured fetch refspec, as in a real clone.
  repo.git('config', 'remote.origin.url', 'https://example.invalid/repo.git')
  repo.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  repo.git('config', 'branch.main.remote', 'origin')
  repo.git('config', 'branch.main.merge', 'refs/heads/main')
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  repo.git('tag', 'v1', c1)
  repo.git('tag', '-a', 'v2', '-m', 'release', c3)
  return { c1, c2, c3, c4 }
}

describe('readBranches', () => {
  it('returns head, local, remote and tag groups with upstream facts', async () => {
    const repo = makeRepo()
    const { c2, c3, c4 } = seed(repo)
    const { run } = makeRunner()

    const value = await readBranches(run, repo.root)

    expect(value.head).toEqual({ branch: 'main', detached: false, sha: c4 })
    expect(value.truncated).toBe(false)

    expect(value.local.map((entry) => entry.name)).toEqual(['feature/x', 'main'])
    expect(value.local.map((entry) => entry.ref)).toEqual([
      'refs/heads/feature/x',
      'refs/heads/main',
    ])
    const main = value.local.find((entry) => entry.name === 'main')
    expect(main).toMatchObject({
      kind: 'local',
      head: true,
      current: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      sha: c4,
    })
    const feature = value.local.find((entry) => entry.name === 'feature/x')
    expect(feature).toMatchObject({ head: false, current: false, ahead: 0, behind: 0, sha: c3 })

    expect(value.remote).toEqual([
      {
        ref: 'refs/remotes/origin/main',
        name: 'origin/main',
        kind: 'remote',
        sha: c2,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
    ])
    // A symbolic remote HEAD is not a branch row.
    expect(value.remote.some((entry) => entry.name === 'origin/HEAD')).toBe(false)

    expect(value.tags.map((entry) => entry.name)).toEqual(['v1', 'v2'])
    expect(value.tags.every((entry) => entry.kind === 'tag')).toBe(true)
    // Annotated tags expose the peeled commit sha, not the tag object.
    expect(value.tags.find((entry) => entry.name === 'v2')?.sha).toBe(c3)
    expect(value.tags.find((entry) => entry.name === 'v1')?.sha).not.toBe('')
  })

  it('reports an unborn branch with a null head sha', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()

    const value = await readBranches(run, repo.root)

    expect(value.head).toEqual({ branch: 'main', detached: false, sha: null })
    expect(value.local).toEqual([])
    expect(value.tags).toEqual([])
  })

  it('reports detached HEAD', async () => {
    const repo = makeRepo()
    const { c1 } = seed(repo)
    repo.git('checkout', '-q', '--detach', c1)
    const { run } = makeRunner()

    const value = await readBranches(run, repo.root)

    expect(value.head).toEqual({ branch: null, detached: true, sha: c1 })
    expect(value.local.every((entry) => entry.current === false)).toBe(true)
    expect(value.local.find((entry) => entry.name === 'main')?.head).toBe(false)
  })

  it('uses one for-each-ref over local, remote and tag refs', async () => {
    const repo = makeRepo()
    seed(repo)
    const { run, fake } = makeRunner()

    await readBranches(run, repo.root)

    const argv = fake.spawns.at(-1)?.spec.argv ?? []
    expect(argv[0]).toBe(GIT_BINARY)
    expect(argv).toContain('for-each-ref')
    expect(argv).toContain('refs/heads')
    expect(argv).toContain('refs/remotes')
    expect(argv).toContain('refs/tags')
    expect(argv.join(' ')).toContain('%00')
  })

  it('does not swallow runner failures', async () => {
    const run: GitRunner = async () => {
      throw new Error('boom')
    }

    await expect(readBranches(run, '/tmp')).rejects.toThrow('boom')
  })
})
