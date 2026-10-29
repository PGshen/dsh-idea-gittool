import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import type { GitRunner } from '../../src/host/git-executor.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { LogQuery } from '../../src/host/git/log.ts'
import { encodeLogCursor, parseLogCursor, readLog } from '../../src/host/git/log.ts'
import { createTempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { GIT_BINARY } from './git-binary.ts'

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
    expect(argv[0]).toBe(GIT_BINARY)
    expect(argv).toContain('log')
    expect(argv).toContain('--max-count=2')
    expect(argv).toContain('--no-ext-diff')
    expect(argv.join(' ')).toContain('--pretty=format:')
    expect(argv).toContain('--')
  })
})

describe('readLog filters', () => {
  /**
   * main: m1 (Alice) → m2 (Bob, "Fix parser bug") → merge(side) → m3 (Alice)
   * side: s1 (Carol, "side feature") from m1
   */
  function seedGraph(): {
    repo: ReturnType<typeof createTempRepo>
    m1: string
    m2: string
    s1: string
    merge: string
    m3: string
  } {
    const repo = makeRepo({ initialCommit: false })
    const as = (name: string, email: string, ...args: string[]): string => {
      repo.git('-c', `user.name=${name}`, '-c', `user.email=${email}`, ...args)
      return repo.git('rev-parse', 'HEAD').trim()
    }
    repo.write('a.txt', '1\n')
    repo.git('add', '-A')
    const m1 = as('Alice', 'alice@example.com', 'commit', '-q', '-m', 'Initial import')
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('s.txt', 's\n')
    repo.git('add', '-A')
    const s1 = as('Carol', 'carol@example.org', 'commit', '-q', '-m', 'side feature\n\nmentions Parser in body')
    repo.git('checkout', '-q', 'main')
    repo.write('a.txt', '2\n')
    repo.git('add', '-A')
    const m2 = as('Bob', 'bob@example.com', 'commit', '-q', '-m', 'Fix parser bug')
    const merge = as('Alice', 'alice@example.com', 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    repo.write('a.txt', '3\n')
    repo.git('add', '-A')
    const m3 = as('Alice', 'alice@example.com', 'commit', '-q', '-m', 'Release a+b (v1)')
    return { repo, m1, m2, s1, merge, m3 }
  }

  const shasOf = (page: { commits: { sha: string }[] }): string[] => page.commits.map((commit) => commit.sha)

  it('matches query text in message, author name or email, case-insensitively by default', async () => {
    const { repo, m2, s1 } = seedGraph()
    const { run } = makeRunner()

    expect(shasOf(await readLog(run, repo.root, { query: 'parser' }))).toEqual([m2, s1])
    expect(shasOf(await readLog(run, repo.root, { query: 'Parser', caseSensitive: true }))).toEqual([s1])
    expect(shasOf(await readLog(run, repo.root, { query: 'carol' }))).toEqual([s1])
    expect(shasOf(await readLog(run, repo.root, { query: 'bob@example' }))).toEqual([m2])
  })

  it('treats the query literally unless regex is set', async () => {
    const { repo, m3, m2 } = seedGraph()
    const { run } = makeRunner()

    expect(shasOf(await readLog(run, repo.root, { query: 'a+b (v1)' }))).toEqual([m3])
    expect(shasOf(await readLog(run, repo.root, { query: '^fix .* bug$', regex: true }))).toEqual([m2])
    await expect(readLog(run, repo.root, { query: '(', regex: true })).rejects.toMatchObject({
      code: 'git/invalid-payload',
    })
  })

  it('matches a hash-shaped query as a sha prefix', async () => {
    const { repo, m2 } = seedGraph()
    const { run } = makeRunner()

    const page = await readLog(run, repo.root, { query: m2.slice(0, 8) })

    expect(shasOf(page)).toEqual([m2])
  })

  it('filters by authors (OR), branches, first parent and merges', async () => {
    const { repo, m1, m2, s1, merge, m3 } = seedGraph()
    const { run } = makeRunner()

    expect(shasOf(await readLog(run, repo.root, { authors: ['Bob', 'carol@example.org'] }))).toEqual([m2, s1])
    expect(shasOf(await readLog(run, repo.root, { branches: ['side'] }))).toEqual([s1, m1])
    expect(shasOf(await readLog(run, repo.root, { firstParent: true }))).toEqual([m3, merge, m2, m1])
    expect(shasOf(await readLog(run, repo.root, { noMerges: true }))).not.toContain(merge)
    const topo = shasOf(await readLog(run, repo.root, { order: 'topo' }))
    expect(topo[0]).toBe(m3)
    expect(topo).toHaveLength(5)
  })

  it('paginates filtered results with a v2 cursor pinned to the filters', async () => {
    const { repo, m1 } = seedGraph()
    const { run, fake } = makeRunner()

    const first = await readLog(run, repo.root, { branches: ['side', 'main'], noMerges: true, limit: 2 })
    expect(first.next).toMatch(/^v2:/)
    expect(first.commits).toHaveLength(2)
    const second = await readLog(run, repo.root, {
      branches: ['side', 'main'],
      noMerges: true,
      limit: 2,
      cursor: first.next,
    })
    expect([...shasOf(first), ...shasOf(second)]).toContain(m1)
    expect(new Set([...shasOf(first), ...shasOf(second)]).size).toBe(4)
    expect(second.next).toBeUndefined()

    // Same cursor with different filters is rejected.
    await expect(readLog(run, repo.root, { limit: 2, cursor: first.next })).rejects.toMatchObject({
      code: 'git/invalid-payload',
    })
    const argv = fake.spawns.find((spawn) => spawn.spec.argv.includes('log'))?.spec.argv ?? []
    expect(argv).toContain('--no-merges')
    expect(argv).toContain('--date-order')
  })

  it('continues a search page by page in raw-stream positions', async () => {
    const repo = makeRepo({ initialCommit: false })
    for (let index = 1; index <= 12; index += 1) {
      repo.write('n.txt', `${index}\n`)
      repo.commit(index % 3 === 0 ? `hit ${index}` : `miss ${index}`)
    }
    const { run } = makeRunner()
    const options = { searchChunk: 4, searchBudget: 4 }

    const subjects: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await readLog(run, repo.root, { query: 'hit', limit: 2, cursor }, options)
      subjects.push(...page.commits.map((commit) => commit.subject))
      cursor = page.next
      if (cursor === undefined) break
    }

    expect(subjects).toEqual(['hit 12', 'hit 9', 'hit 6', 'hit 3'])
  })

  it('rejects malformed filters and unknown branches', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()
    const bad: LogQuery[] = [
      { query: 42 as never },
      { regex: 'yes' as never },
      { order: 'random' as never },
      { branches: 'main' as never },
      { branches: ['--all'] },
      { branches: ['main..side'] },
      { branches: ['nope'] },
      { authors: [''] },
      { query: 'x'.repeat(500) },
    ]
    for (const query of bad) {
      await expect(readLog(run, repo.root, query), JSON.stringify(query)).rejects.toMatchObject({
        code: 'git/invalid-payload',
      })
    }
  })
})

describe('readLog search chunking', () => {
  it('halves the search chunk when a chunk overflows the output cap', async () => {
    const repo = makeRepo({ initialCommit: false })
    commitSeries(repo, 6)
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake, { stdoutMaxBytes: 700 })

    const page = await readLog(run, repo.root, { query: 'commit', limit: 1 }, { searchChunk: 6 })

    expect(page.commits.map((commit) => commit.subject)).toEqual(['commit 6'])
    expect(fake.spawns.filter((spawn) => spawn.spec.argv.includes('log')).length).toBeGreaterThan(1)
  })
})

describe('readLog regex search isolation', () => {
  const shasOf = (page: { commits: { sha: string }[] }): string[] => page.commits.map((commit) => commit.sha)

  it('times out a catastrophic regex without blocking the Host event loop', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'x\n')
    repo.commit(`${'a'.repeat(32)}!`)
    const { run } = makeRunner()

    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 20)
    const startedAt = Date.now()
    try {
      await expect(
        readLog(run, repo.root, { query: '^(a+)+$', regex: true }, { regexTimeoutMs: 300 }),
      ).rejects.toMatchObject({ code: 'git/timeout' })
    } finally {
      clearInterval(ticker)
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    // The main thread kept running timers while the pattern spun in the worker.
    expect(ticks).toBeGreaterThan(3)
  })

  it('still matches ordinary regexes across message, author and email', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'one\n')
    const target = repo.commit('feat: Worker isolation')
    repo.write('a.txt', 'two\n')
    repo.commit('chore: unrelated')
    const { run } = makeRunner()

    expect(shasOf(await readLog(run, repo.root, { query: 'worker\\s+iso', regex: true }))).toEqual([target])
    expect(shasOf(await readLog(run, repo.root, { query: 'Worker', regex: true, caseSensitive: true }))).toEqual([target])
    expect(await readLog(run, repo.root, { query: 'worker', regex: true, caseSensitive: true })).toMatchObject({ commits: [] })
  })
})
