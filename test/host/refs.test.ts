import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import type { GitRunner } from '../../src/host/git-executor.ts'
import { createGitRunner } from '../../src/host/git-executor.ts'
import { readRefs } from '../../src/host/git/refs.ts'
import { createTempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

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

function seed(repo: ReturnType<typeof createTempRepo>): {
  c1: string
  c2: string
} {
  repo.write('a.txt', 'one\n')
  const c1 = repo.commit('c1')
  repo.write('a.txt', 'two\n')
  const c2 = repo.commit('c2')
  repo.git('tag', 'v1', c1)
  repo.git('tag', '-a', 'v2', '-m', 'release', c2)
  repo.git('tag', 'latest', c2)
  repo.git('branch', 'feature/x')
  repo.git('update-ref', 'refs/remotes/origin/main', c2)
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return { c1, c2 }
}

describe('readRefs', () => {
  it('indexes refs by the commit they point at', async () => {
    const repo = makeRepo()
    const { c1, c2 } = seed(repo)
    const { run } = makeRunner()

    const value = await readRefs(run, repo.root)

    expect(value.truncated).toBe(false)
    expect(Object.keys(value.bySha).sort()).toEqual([c1, c2].sort())
    expect(value.bySha[c1]).toEqual([
      { ref: 'refs/tags/v1', name: 'v1', kind: 'tag', sha: c1 },
    ])
    expect(value.bySha[c2]).toEqual([
      { ref: 'refs/heads/feature/x', name: 'feature/x', kind: 'local', sha: c2 },
      { ref: 'refs/heads/main', name: 'main', kind: 'local', sha: c2 },
      { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', sha: c2 },
      { ref: 'refs/tags/latest', name: 'latest', kind: 'tag', sha: c2 },
      { ref: 'refs/tags/v2', name: 'v2', kind: 'tag', sha: c2 },
    ])
  })

  it('drops symbolic refs such as origin/HEAD', async () => {
    const repo = makeRepo()
    seed(repo)
    const { run } = makeRunner()

    const value = await readRefs(run, repo.root)

    for (const entries of Object.values(value.bySha)) {
      expect(entries.some((entry) => entry.name === 'origin/HEAD')).toBe(false)
    }
  })

  it('exposes the peeled commit for annotated tags but not the tag object sha', async () => {
    const repo = makeRepo()
    const { c2 } = seed(repo)
    const tagObject = repo.git('rev-parse', 'refs/tags/v2').trim()
    const { run } = makeRunner()

    const value = await readRefs(run, repo.root)

    expect(tagObject).not.toBe(c2)
    expect(value.bySha[tagObject]).toBeUndefined()
    expect(value.bySha[c2]?.find((entry) => entry.name === 'v2')?.sha).toBe(c2)
  })

  it('works for a repository without refs', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()

    const value = await readRefs(run, repo.root)

    expect(value).toEqual({ bySha: {}, truncated: false })
  })

  it('uses one for-each-ref with NUL separators over every ref namespace', async () => {
    const repo = makeRepo()
    seed(repo)
    const { run, fake } = makeRunner()

    await readRefs(run, repo.root)

    const argv = fake.spawns.at(-1)?.spec.argv ?? []
    expect(argv).toContain('for-each-ref')
    expect(argv).toContain('refs/heads')
    expect(argv).toContain('refs/remotes')
    expect(argv).toContain('refs/tags')
    expect(argv.join(' ')).toContain('%00')
    expect(argv.join(' ')).toContain('%(symref)')
  })
})
