import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { parseRawNumstat, readCommit } from '../../src/host/git/commit.ts'
import { createTempDir, createTempRepo, removeTempDir } from './fixtures.ts'
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

const run = createGitRunner(createFakeSubprocess())

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

describe('parseRawNumstat', () => {
  it('merges raw status with numstat counts, renames and binaries', () => {
    const raw = [
      ':100644 100644 aaa bbb M',
      'b.txt',
      ':100644 100644 ccc ddd M',
      'bin.dat',
      ':100644 100644 eee eee R100',
      'a.txt',
      'c.txt',
      '1\t0\tb.txt',
      '-\t-\tbin.dat',
      '0\t0\t',
      'a.txt',
      'c.txt',
      '',
    ].join('\0')

    expect(parseRawNumstat(raw)).toEqual([
      expect.objectContaining({ status: 'M', path: 'b.txt', additions: 1, deletions: 0, binary: false }),
      expect.objectContaining({ status: 'M', path: 'bin.dat', binary: true }),
      expect.objectContaining({ status: 'R', path: 'c.txt', origPath: 'a.txt', additions: 0, deletions: 0 }),
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseRawNumstat('')).toEqual([])
  })
})

describe('readCommit', () => {
  it('returns metadata, refs and files of a regular commit', async () => {
    const repo = makeRepo()
    repo.write('a.txt', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n')
    repo.write('b.txt', 'b\n')
    repo.write('bin.dat', '\u0000\u0001')
    const c1 = repo.commit('first')
    repo.git('mv', 'a.txt', 'renamed.txt')
    repo.write('b.txt', 'b\nb2\nb3\n')
    repo.write('bin.dat', '\u0000\u0002\u0003')
    repo.write('dir/new.txt', 'n\n')
    repo.git('add', '-A')
    repo.git(
      '-c',
      'user.name=Alice',
      '-c',
      'user.email=alice@example.com',
      'commit',
      '-q',
      '-m',
      'second subject\n\nbody line 1\nbody line 2',
    )
    const c2 = repo.git('rev-parse', 'HEAD').trim()
    repo.git('tag', '-a', 'v2', '-m', 'release', c2)
    repo.git('tag', 'light', c2)

    const value = await readCommit(run, repo.root, c2.slice(0, 10))

    expect(value.sha).toBe(c2)
    expect(value.shortSha.length).toBeGreaterThanOrEqual(4)
    expect(value.subject).toBe('second subject')
    expect(value.body).toBe('body line 1\nbody line 2')
    expect(value.author).toMatchObject({ name: 'Alice', email: 'alice@example.com' })
    expect(value.author.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(value.committer.name).toBe('Alice')
    expect(value.parents).toEqual([{ sha: c1, shortSha: expect.any(String), subject: 'first' }])
    expect(value.refs.map((ref) => ref.name)).toEqual(['main', 'light', 'v2'])
    expect(value.parentGroups).toBeUndefined()
    expect(value.truncated).toBe(false)

    const byPath = Object.fromEntries(value.files.map((file) => [file.path, file]))
    expect(byPath['renamed.txt']).toMatchObject({ status: 'R', origPath: 'a.txt', additions: 0, deletions: 0 })
    expect(byPath['b.txt']).toMatchObject({ status: 'M', additions: 2, deletions: 0, parentSha: c1 })
    expect(byPath['bin.dat']).toMatchObject({ status: 'M' })
    expect(byPath['bin.dat']?.additions).toBeUndefined()
    expect(byPath['dir/new.txt']).toMatchObject({ status: 'A', additions: 1, deletions: 0 })
  })

  it('handles a root commit', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    const c1 = repo.commit('root')

    const value = await readCommit(run, repo.root, c1)

    expect(value.parents).toEqual([])
    expect(value.files).toEqual([{ path: 'a.txt', status: 'A', additions: 1, deletions: 0 }])
  })

  it('groups merge commit files by parent', async () => {
    const repo = makeRepo()
    repo.write('base.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('side.txt', 'side\n')
    const side = repo.commit('side work')
    repo.git('checkout', '-q', 'main')
    repo.write('main.txt', 'main\n')
    const main = repo.commit('main work')
    repo.git('-c', 'user.name=T', '-c', 'user.email=t@e', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const merge = repo.git('rev-parse', 'HEAD').trim()

    const value = await readCommit(run, repo.root, merge)

    expect(value.parents.map((parent) => parent.sha)).toEqual([main, side])
    expect(value.parents.map((parent) => parent.subject)).toEqual(['main work', 'side work'])
    expect(value.parentGroups).toEqual([
      { parentSha: main, files: [{ path: 'side.txt', status: 'A', additions: 1, deletions: 0, parentSha: main }] },
      { parentSha: side, files: [{ path: 'main.txt', status: 'A', additions: 1, deletions: 0, parentSha: side }] },
    ])
    expect(value.files).toEqual(value.parentGroups?.[0]?.files)
  })

  it('truncates the file list beyond the limit', async () => {
    const repo = makeRepo()
    for (let i = 0; i < 5; i += 1) repo.write(`f${i}.txt`, `${i}\n`)
    const c1 = repo.commit('many')

    const value = await readCommit(run, repo.root, c1, { fileLimit: 3 })

    expect(value.truncated).toBe(true)
    expect(value.files).toHaveLength(3)
  })

  it('rejects malformed and unknown shas as invalid payloads', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.commit('root')
    const tree = repo.git('rev-parse', 'HEAD^{tree}').trim()

    expect(await codeOf(readCommit(run, repo.root, 'HEAD'))).toBe('git/invalid-payload')
    expect(await codeOf(readCommit(run, repo.root, '--all'))).toBe('git/invalid-payload')
    expect(await codeOf(readCommit(run, repo.root, 'abc'))).toBe('git/invalid-payload')
    expect(await codeOf(readCommit(run, repo.root, 42))).toBe('git/invalid-payload')
    expect(await codeOf(readCommit(run, repo.root, 'deadbeefdeadbeef'))).toBe('git/invalid-payload')
    // A tree object is not a commit.
    expect(await codeOf(readCommit(run, repo.root, tree))).toBe('git/invalid-payload')
  })

  it('reports a directory outside any repository', async () => {
    const dir = createTempDir('dsh-git-outside-')
    cleanups.push(() => removeTempDir(dir))

    expect(await codeOf(readCommit(run, dir, 'deadbeef'))).toBe('git/not-a-repository')
  })
})
