// B2 T3：比较模式（提交列表 + 差异文件，真实临时仓库）。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { readCompare } from '../../src/host/git/compare.ts'
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
  const repo = createTempRepo()
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

/** main and feature fork from the initial commit; both add commits and touch files. */
function forked(repo: TempRepo): void {
  repo.write('shared.txt', 'base\n')
  repo.write('rename-me.txt', 'one\ntwo\nthree\nfour\n')
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('feature.txt', 'f\n')
  repo.commit('feature 1')
  repo.git('mv', 'rename-me.txt', 'renamed.txt')
  repo.commit('feature 2')
  repo.git('checkout', '-q', 'main')
  repo.write('shared.txt', 'main change\n')
  repo.commit('main 1')
}

function names(output: string): string[] {
  return output.split('\n').filter(line => line !== '')
}

describe('readCompare', () => {
  it('lists commits in left but not right and the files changed on left since the merge base', async () => {
    const repo = makeRepo()
    forked(repo)
    const value = await readCompare(run, repo.root, { sessionId: 's', left: 'feature', right: 'main' })
    expect(value.left).toEqual({ input: 'feature', sha: repo.git('rev-parse', 'feature').trim() })
    expect(value.right).toEqual({ input: 'main', sha: repo.git('rev-parse', 'main').trim() })
    expect(value.commits.map(commit => commit.subject)).toEqual(names(repo.git('log', '--format=%s', 'main..feature')))
    expect(value.files.map(file => [file.status, file.path, file.origPath])).toEqual([
      ['A', 'feature.txt', undefined],
      ['R', 'renamed.txt', 'rename-me.txt'],
    ])
    expect(value.filesTruncated).toBe(false)
  })

  it('swapping sides swaps both lists', async () => {
    const repo = makeRepo()
    forked(repo)
    const value = await readCompare(run, repo.root, { sessionId: 's', left: 'main', right: 'feature' })
    expect(value.commits.map(commit => commit.subject)).toEqual(['main 1'])
    expect(value.files.map(file => file.path)).toEqual(['shared.txt'])
  })

  it('compares a revision with the worktree: files only, staged and unstaged together', async () => {
    const repo = makeRepo()
    forked(repo)
    repo.write('shared.txt', 'dirty\n')
    repo.write('staged.txt', 's\n')
    repo.git('add', 'staged.txt')
    const value = await readCompare(run, repo.root, { sessionId: 's', left: 'feature', right: null })
    expect(value.right).toBeNull()
    expect(value.commits).toEqual([])
    expect(value.next).toBeUndefined()
    const expected = names(repo.git('diff', '--name-only', '-M', 'feature'))
    expect(value.files.map(file => file.path).sort()).toEqual(expected.sort())
  })

  it('pages the commit list', async () => {
    const repo = makeRepo()
    repo.git('checkout', '-q', '-b', 'topic')
    for (let index = 1; index <= 3; index += 1) {
      repo.write('t.txt', `${String(index)}\n`)
      repo.commit(`t${String(index)}`)
    }
    const first = await readCompare(run, repo.root, { sessionId: 's', left: 'topic', right: 'main', limit: 2 })
    expect(first.commits.map(commit => commit.subject)).toEqual(['t3', 't2'])
    const second = await readCompare(run, repo.root, { sessionId: 's', left: 'topic', right: 'main', limit: 2, cursor: first.next })
    expect(second.commits.map(commit => commit.subject)).toEqual(['t1'])
    expect(second.next).toBeUndefined()
  })

  it('falls back to a two-point file diff for unrelated histories', async () => {
    const repo = makeRepo()
    repo.git('checkout', '-q', '--orphan', 'other')
    repo.git('rm', '-rqf', '.')
    repo.write('alone.txt', 'x\n')
    repo.commit('orphan')
    const value = await readCompare(run, repo.root, { sessionId: 's', left: 'other', right: 'main' })
    expect(value.commits.map(commit => commit.subject)).toEqual(['orphan'])
    expect(value.files.map(file => [file.status, file.path]).sort()).toEqual([['A', 'alone.txt'], ['D', 'README.md']])
  })

  it('refuses option-like revisions and a cursor of another left side', async () => {
    const repo = makeRepo()
    forked(repo)
    expect(await codeOf(readCompare(run, repo.root, { sessionId: 's', left: '--all', right: 'main' }))).toBe('git/invalid-payload')
    expect(await codeOf(readCompare(run, repo.root, { sessionId: 's', left: 'main', right: '-x' }))).toBe('git/invalid-payload')
    const page = await readCompare(run, repo.root, { sessionId: 's', left: 'feature', right: 'main', limit: 1 })
    expect(await codeOf(readCompare(run, repo.root, { sessionId: 's', left: 'main', right: 'feature', cursor: page.next }))).toBe('git/invalid-payload')
  })
})
