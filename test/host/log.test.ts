import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import type { GitRunner } from '../../src/host/git-executor.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { LogQuery } from '../../src/host/git/log.ts'
import { encodeLogCursor, parseLogCursor, readLog } from '../../src/host/git/log.ts'
import { createTempRepo } from './fixtures.ts'
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

/** Create `count` commits over one file, returning their shas oldest-first. */
function commitSeries(repo: ReturnType<typeof createTempRepo>, count: number): string[] {
  const shas: string[] = []
  for (let index = 1; index <= count; index += 1) {
    repo.write('series.txt', `line ${index}\n`)
    shas.push(repo.commit(`commit ${index}`))
  }
  return shas
}

describe('log cursors', () => {
  it('round-trips head and offset', () => {
    const head = 'c'.repeat(40)

    const cursor = encodeLogCursor(head, 10)

    expect(cursor).toBe(`v1:${head}:10`)
    expect(parseLogCursor(cursor)).toEqual({ head, offset: 10 })
  })

  it('rejects malformed cursors', () => {
    for (const cursor of ['', 'v1', 'v1:abc', 'v2:abc:0', 'v1:zzz:0', 'v1:abc:-1']) {
      expect(() => parseLogCursor(cursor)).toThrowError(GitCommandFailure)
    }
  })
})

describe('readLog', () => {
  it('returns the newest commits with author and parent facts', async () => {
    const repo = makeRepo({ initialCommit: false })
    const shas = commitSeries(repo, 3)
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, {})

    expect(page.commits.map((commit) => commit.sha)).toEqual([...shas].reverse())
    expect(page.next).toBeUndefined()
    expect(page.truncated).toBe(false)

    const newest = page.commits[0]
    expect(newest).toMatchObject({ author: 'Test', email: 'test@example.com', subject: 'commit 3' })
    expect(newest?.parents).toEqual([shas[1]])
    expect(newest?.shortSha).toHaveLength(7)
    expect(newest?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reports an empty page for a repository without commits', async () => {
    const repo = makeRepo({ initialCommit: false })
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, {})

    expect(page).toEqual({ commits: [], truncated: false })
  })

  it('paginates with an opaque cursor anchored on the first page head', async () => {
    const repo = makeRepo({ initialCommit: false })
    const shas = commitSeries(repo, 5).reverse()
    const { run } = makeRunner()

    const first = await readLog(run, repo.root, { limit: 2 })
    expect(first.commits.map((commit) => commit.sha)).toEqual(shas.slice(0, 2))
    expect(first.truncated).toBe(true)
    expect(first.next).toBeDefined()
    expect(parseLogCursor(first.next ?? '')).toEqual({ head: shas[0] ?? '', offset: 2 })

    const second = await readLog(run, repo.root, { limit: 2, cursor: first.next })
    expect(second.commits.map((commit) => commit.sha)).toEqual(shas.slice(2, 4))
    expect(second.truncated).toBe(true)

    const third = await readLog(run, repo.root, { limit: 2, cursor: second.next })
    expect(third.commits.map((commit) => commit.sha)).toEqual(shas.slice(4))
    expect(third.truncated).toBe(false)
    expect(third.next).toBeUndefined()
  })

  it('keeps the pinned head when new commits land between pages', async () => {
    const repo = makeRepo({ initialCommit: false })
    const shas = commitSeries(repo, 4).reverse()
    const { run } = makeRunner()

    const first = await readLog(run, repo.root, { limit: 2 })
    repo.write('series.txt', 'line 5\n')
    repo.commit('late commit')
    const second = await readLog(run, repo.root, { limit: 2, cursor: first.next })

    expect(second.commits.map((commit) => commit.sha)).toEqual(shas.slice(2, 4))
    expect(second.next).toBeUndefined()
  })

  it('gives the root commit an empty parent list', async () => {
    const repo = makeRepo({ initialCommit: false })
    const root = repo.commit('root')
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, {})

    expect(page.commits).toHaveLength(1)
    expect(page.commits[0]?.sha).toBe(root)
    expect(page.commits[0]?.parents).toEqual([])
  })

  it('preserves a subject containing the field separator', async () => {
    const repo = makeRepo()
    repo.write('weird.txt', 'weird\n')
    const subject = 'weird\u001fsubject'
    repo.git('add', '-A')
    repo.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', subject)
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, {})

    expect(page.commits[0]?.subject).toBe(subject)
  })

  it('rejects invalid limits and cursors with git/invalid-payload', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(readLog(run, repo.root, { limit })).rejects.toMatchObject({
        code: 'git/invalid-payload',
      })
    }
    await expect(readLog(run, repo.root, { cursor: 'garbage' })).rejects.toMatchObject({
      code: 'git/invalid-payload',
    })
  })

  it('rejects a cursor whose pinned head no longer exists', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()
    const cursor = encodeLogCursor('0'.repeat(40), 0)

    await expect(readLog(run, repo.root, { cursor })).rejects.toMatchObject({
      code: 'git/invalid-payload',
    })
  })

  it('clamps a limit above the page maximum', async () => {
    const repo = makeRepo({ initialCommit: false })
    commitSeries(repo, 3)
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, { limit: 5000 })

    expect(page.commits).toHaveLength(3)
    expect(page.next).toBeUndefined()
  })

  it('does not swallow runner failures', async () => {
    const run: GitRunner = async () => {
      throw new GitCommandFailure('git/timeout', 'git log timed out')
    }

    await expect(readLog(run, '/tmp', {})).rejects.toMatchObject({ code: 'git/timeout' })
  })

  it('uses --max-count and a literal separator, never a shell', async () => {
    const repo = makeRepo()
    commitSeries(repo, 2)
    const { run, fake } = makeRunner()
    const query: LogQuery = { limit: 1 }

    await readLog(run, repo.root, query)

    const argv = fake.spawns.at(-1)?.spec.argv ?? []
    expect(argv[0]).toBe('git')
    expect(argv).toContain('log')
    expect(argv).toContain('--max-count=2')
    expect(argv).toContain('--no-ext-diff')
    expect(argv.join(' ')).toContain('--pretty=format:')
    expect(argv).toContain('--')
  })
})
