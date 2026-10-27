// B2 T3：文件历史（--follow，真实临时仓库）。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { readDiff } from '../../src/host/git/diff.ts'
import { readFileHistory } from '../../src/host/git/file-history.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const run = createGitRunner(createFakeSubprocess())

function makeRepo(): TempRepo {
  const repo = createTempRepo({ initialCommit: false })
  cleanups.push(repo.cleanup)
  return repo
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

/** old.txt is created, renamed to new.txt, then edited; other.txt changes in between. */
function renamedRepo(repo: TempRepo): { create: string; rename: string; edit: string } {
  repo.write('old.txt', 'a\nb\nc\nd\ne\n')
  repo.write('other.txt', '1\n')
  const create = repo.commit('create')
  repo.git('mv', 'old.txt', 'new.txt')
  const rename = repo.commit('rename')
  repo.write('other.txt', '2\n')
  repo.commit('unrelated')
  repo.write('new.txt', 'a\nb\nc\nd\nE\nF\n')
  const edit = repo.commit('edit')
  return { create, rename, edit }
}

describe('readFileHistory', () => {
  it('lists only commits that touched the file, across the rename, with per-file status and counts', async () => {
    const repo = makeRepo()
    const { create, rename, edit } = renamedRepo(repo)
    const value = await readFileHistory(run, repo.root, { sessionId: 's', path: 'new.txt' })
    expect(value.path).toBe('new.txt')
    expect(value.followedRename).toBe(true)
    expect(value.next).toBeUndefined()
    expect(value.entries.map(entry => [entry.sha, entry.subject, entry.path, entry.status, entry.origPath])).toEqual([
      [edit, 'edit', 'new.txt', 'M', undefined],
      [rename, 'rename', 'new.txt', 'R', 'old.txt'],
      [create, 'create', 'old.txt', 'A', undefined],
    ])
    expect(value.entries[0]).toMatchObject({ additions: 2, deletions: 1, author: 'Test' })
    expect(value.entries[2]).toMatchObject({ additions: 5, deletions: 0 })
  })

  it('takes the diff of a pre-rename commit by the path the entry carries', async () => {
    const repo = makeRepo()
    const { create } = renamedRepo(repo)
    const value = await readFileHistory(run, repo.root, { sessionId: 's', path: 'new.txt' })
    const oldest = value.entries.at(-1)
    expect(oldest?.sha).toBe(create)
    const diff = await readDiff(run, repo.root, { path: oldest?.path, scope: 'commit', sha: create })
    expect(diff).toMatchObject({ status: 'A', newPath: 'old.txt' })
    expect(diff.hunks[0]?.lines.length).toBe(5)
  })

  it('does not report a rename for a file that was never renamed', async () => {
    const repo = makeRepo()
    renamedRepo(repo)
    const value = await readFileHistory(run, repo.root, { sessionId: 's', path: 'other.txt' })
    expect(value.followedRename).toBe(false)
    expect(value.entries.map(entry => entry.subject)).toEqual(['unrelated', 'create'])
  })

  it('pages with a cursor pinned to the first page head', async () => {
    const repo = makeRepo()
    for (let index = 1; index <= 5; index += 1) {
      repo.write('f.txt', `${String(index)}\n`)
      repo.commit(`c${String(index)}`)
    }
    const first = await readFileHistory(run, repo.root, { sessionId: 's', path: 'f.txt', limit: 2 })
    expect(first.entries.map(entry => entry.subject)).toEqual(['c5', 'c4'])
    expect(first.next).toMatch(/^v1:[0-9a-f]{40}:2$/)
    repo.write('f.txt', 'later\n')
    repo.commit('c6')
    const second = await readFileHistory(run, repo.root, { sessionId: 's', path: 'f.txt', limit: 2, cursor: first.next })
    expect(second.entries.map(entry => entry.subject)).toEqual(['c3', 'c2'])
    const third = await readFileHistory(run, repo.root, { sessionId: 's', path: 'f.txt', limit: 2, cursor: second.next })
    expect(third.entries.map(entry => entry.subject)).toEqual(['c1'])
    expect(third.next).toBeUndefined()
  })

  it('starts from a revision and marks binary changes', async () => {
    const repo = makeRepo()
    repo.write('bin.dat', 'a\0b')
    repo.commit('one')
    repo.write('bin.dat', 'c\0d')
    repo.commit('two')
    const value = await readFileHistory(run, repo.root, { sessionId: 's', path: 'bin.dat', rev: 'HEAD~1' })
    expect(value.entries.map(entry => [entry.subject, entry.binary])).toEqual([['one', true]])
  })

  it('keeps odd paths literal and refuses option-like revisions and foreign cursors', async () => {
    const repo = makeRepo()
    repo.write('-dash 空.txt', 'x\n')
    repo.commit('odd')
    expect((await readFileHistory(run, repo.root, { sessionId: 's', path: '-dash 空.txt' })).entries).toHaveLength(1)
    expect(await codeOf(readFileHistory(run, repo.root, { sessionId: 's', path: 'x', rev: '--all' }))).toBe('git/invalid-payload')
    expect(await codeOf(readFileHistory(run, repo.root, { sessionId: 's', path: '../x' }))).toBe('git/invalid-payload')
    expect(await codeOf(readFileHistory(run, repo.root, { sessionId: 's', path: 'x', cursor: 'nope' }))).toBe('git/invalid-payload')
  })

  it('answers an unborn repository with an empty history', async () => {
    const repo = makeRepo()
    expect(await readFileHistory(run, repo.root, { sessionId: 's', path: 'f.txt' })).toMatchObject({ entries: [], followedRename: false })
  })
})
