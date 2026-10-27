// B3a T2：交互式变基计划（真实临时仓库）。
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { REBASE_PLAN_MAX_COMMITS } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { readRebasePlan } from '../../src/host/git/rebase-plan.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { TEST_GIT_ENV, createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { createRemoteSetup } from './remote-fixtures.ts'

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

/** initial commit + c1..c<count> on main, each touching its own file. */
function linear(repo: TempRepo, count: number): string[] {
  const shas: string[] = []
  for (let index = 1; index <= count; index += 1) {
    repo.write(`f${String(index)}.txt`, `${String(index)}\n`)
    shas.push(repo.commit(`c${String(index)}\n\nbody of c${String(index)}\n# not a comment`))
  }
  return shas
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

describe('readRebasePlan', () => {
  it('lists base..HEAD oldest first with full messages', async () => {
    const repo = makeRepo()
    const shas = linear(repo, 5)
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~3' })
    expect(value.base).toBe(shas[1])
    expect(value.head).toBe(shas[4])
    expect(value.branch).toBe('main')
    expect(value.blocked).toBeUndefined()
    expect(value.commits.map(commit => commit.sha)).toEqual(shas.slice(2))
    expect(value.commits.map(commit => commit.sha)).toEqual(
      repo.git('rev-list', '--reverse', '--first-parent', 'HEAD~3..HEAD').trim().split('\n'),
    )
    expect(value.commits[0]).toMatchObject({ subject: 'c3', message: 'c3\n\nbody of c3\n# not a comment', pushed: false, branches: [] })
    expect(value.commits[0]?.parents).toEqual([shas[1]])
  })

  it('starts from the root commit when base is null', async () => {
    const repo = makeRepo()
    linear(repo, 2)
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: null })
    expect(value.base).toBeNull()
    expect(value.commits.map(commit => commit.subject)).toEqual(['initial commit', 'c1', 'c2'])
    expect(value.commits[0]?.parents).toEqual([])
  })

  it('marks commits reachable from any remote-tracking branch as pushed', async () => {
    const setup = createRemoteSetup()
    cleanups.push(setup.cleanup)
    const repo = setup.local
    linear(repo, 3)
    repo.git('push', '-q', 'origin', 'HEAD~1:refs/heads/main')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~3' })
    expect(value.commits.map(commit => [commit.subject, commit.pushed])).toEqual([
      ['c1', true],
      ['c2', true],
      ['c3', false],
    ])
  })

  it('lists other local branches pointing at each commit, never the current one', async () => {
    const repo = makeRepo()
    const shas = linear(repo, 3)
    repo.git('branch', 'mid', shas[1] ?? '')
    repo.git('branch', 'also-mid', shas[1] ?? '')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~3' })
    expect(value.commits.map(commit => commit.branches)).toEqual([[], ['also-mid', 'mid'], []])
  })

  it('names branches by their full ref even when a tag shares the name (review I1)', async () => {
    const repo = makeRepo()
    const shas = linear(repo, 2)
    repo.git('branch', 'foo', shas[0] ?? '')
    repo.git('tag', 'foo', shas[1] ?? '')
    repo.git('tag', 'main', shas[0] ?? '')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~2' })
    expect(value.branch).toBe('main')
    expect(value.commits.map(commit => commit.branches)).toEqual([['foo'], []])
  })

  it('leaves out branches checked out in another worktree (review I2)', async () => {
    const repo = makeRepo()
    const shas = linear(repo, 2)
    repo.git('branch', 'wt', shas[0] ?? '')
    const other = `${repo.root}-wt`
    repo.git('worktree', 'add', '-q', other, 'wt')
    cleanups.push(() => { rmSync(other, { recursive: true, force: true }) })
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~2' })
    expect(value.commits.map(commit => commit.branches)).toEqual([[], []])
  })

  it('keeps messages with record and field separator characters intact (review M7)', async () => {
    const repo = makeRepo()
    repo.write('x.txt', 'x\n')
    repo.git('add', '-A')
    repo.git('-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'odd \x1e record \x1f field')
    const message = repo.git('log', '-1', '--format=%B').replace(/\n+$/u, '')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~1' })
    expect(value.commits).toHaveLength(1)
    expect(value.commits[0]?.message).toBe(message)
  })

  it('blocks a range containing a merge commit', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('side.txt', 'side\n')
    repo.commit('side')
    repo.git('checkout', '-q', 'main')
    repo.write('main.txt', 'main\n')
    repo.commit('main')
    repo.git('-c', 'user.name=T', '-c', 'user.email=t@x', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~2' })
    expect(value.blocked).toBe('merge-commit')
    expect(value.commits).toEqual([])
  })

  it('blocks a base that is not an ancestor of HEAD', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    repo.git('checkout', '-q', '-b', 'other')
    repo.write('o.txt', 'o\n')
    repo.commit('other')
    repo.git('checkout', '-q', 'main')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'other' })
    expect(value.blocked).toBe('not-ancestor')
    expect(value.commits).toEqual([])
  })

  it('blocks a detached HEAD', async () => {
    const repo = makeRepo()
    linear(repo, 2)
    repo.git('checkout', '-q', '--detach', 'HEAD')
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD~1' })
    expect(value.blocked).toBe('detached')
    expect(value.branch).toBe('')
  })

  it('blocks an empty range (base is HEAD)', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    expect((await readRebasePlan(run, repo.root, { sessionId: 's', base: 'HEAD' })).blocked).toBe('empty')
  })

  it(`blocks more than ${String(REBASE_PLAN_MAX_COMMITS)} commits`, async () => {
    const repo = makeRepo()
    const base = repo.git('rev-parse', 'HEAD').trim()
    // One fast-import process instead of 501 `git commit` runs (the full suite runs in parallel).
    const stream = Array.from({ length: REBASE_PLAN_MAX_COMMITS + 1 }, (_, index) => [
      'commit refs/heads/main',
      `mark :${String(index + 1)}`,
      'committer T <t@x> 0 +0000',
      `data ${String(`e${String(index)}`.length)}`,
      `e${String(index)}`,
      `from ${index === 0 ? base : `:${String(index)}`}`,
      '',
    ].join('\n')).join('')
    const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo.root, env: TEST_GIT_ENV, input: stream, encoding: 'utf8' })
    expect(imported.status, imported.stderr).toBe(0)
    const value = await readRebasePlan(run, repo.root, { sessionId: 's', base })
    expect(value.blocked).toBe('too-many')
    expect(value.commits).toEqual([])
  })

  it('reports --update-refs support from the git version', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    const request = { sessionId: 's', base: 'HEAD~1' }
    expect((await readRebasePlan(run, repo.root, request, { gitVersion: '2.38.0' })).supportsUpdateRefs).toBe(true)
    expect((await readRebasePlan(run, repo.root, request, { gitVersion: '2.37.9' })).supportsUpdateRefs).toBe(false)
    expect((await readRebasePlan(run, repo.root, request, { gitVersion: undefined })).supportsUpdateRefs).toBe(false)
  })

  it('rejects an option-like or unknown base with git/invalid-payload', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    expect(await codeOf(readRebasePlan(run, repo.root, { sessionId: 's', base: '--exec=touch x' }))).toBe('git/invalid-payload')
    expect(await codeOf(readRebasePlan(run, repo.root, { sessionId: 's', base: 'no-such-branch' }))).toBe('git/invalid-payload')
  })
})
