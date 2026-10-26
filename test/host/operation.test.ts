// A3 T2：操作详情、继续/跳过/中止、合并中提交（真实临时仓库）。
// 重点：不挂起（continue 不等编辑器）、贮藏永不丢（abort/continue 后按 sha 恢复，丢失时 stashMissing）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GIT_BASE_ARGV, GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import {
  operationCommitOperation,
  operationControlOperation,
  readOperationState,
} from '../../src/host/git/operation.ts'
import { pendingStashPath, withSmartStash } from '../../src/host/git/smart-stash.ts'
import { readStatus } from '../../src/host/git/status.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const runner = createGitRunner(createFakeSubprocess())

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(repo.cleanup)
  return repo
}

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  return 'ok'
}

async function control(ctx: WriteContext, action: string) {
  const op = operationControlOperation
  return await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', action }))
}

async function commitInOperation(ctx: WriteContext, message: string) {
  const op = operationCommitOperation
  return await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', message }))
}

async function state(repo: TempRepo) {
  return await readOperationState(runner, repo.root, {})
}

function sha(repo: TempRepo, rev: string): string {
  return repo.git('rev-parse', rev).trim()
}

function short(repo: TempRepo, rev: string): string {
  return repo.git('rev-parse', '--short', rev).trim()
}

function stashShas(repo: TempRepo): string[] {
  return repo.git('stash', 'list', '--format=%H').split('\n').filter(Boolean)
}

function gitDir(repo: TempRepo): string {
  return repo.git('rev-parse', '--absolute-git-dir').trim()
}

/**
 * main and feature both edit a.txt and b.txt (conflicts); feature alone adds c.txt
 * (auto-merged, staged). Leaves `main` checked out.
 */
function conflictingBranches(repo: TempRepo): void {
  repo.write('a.txt', 'base a\n')
  repo.write('b.txt', 'base b\n')
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('a.txt', 'feature a\n')
  repo.write('b.txt', 'feature b\n')
  repo.write('c.txt', 'feature c\n')
  repo.commit('feature change')
  repo.git('checkout', '-q', 'main')
  repo.write('a.txt', 'main a\n')
  repo.write('b.txt', 'main b\n')
  repo.commit('main change')
}

/** Merge feature through the smart stash (dirty README.md), stopping on conflicts. */
async function smartMergeStopped(repo: TempRepo): Promise<WriteContext> {
  conflictingBranches(repo)
  repo.write('README.md', '# my uncommitted edit\n')
  const ctx = contextFor(repo)
  const failure = await failureOf(
    withSmartStash(ctx, { stash: true, operation: 'merge' }, async () => {
      const result = await ctx.git([...GIT_BASE_ARGV, 'merge', '--no-edit', 'feature'])
      if (result.exitCode !== 0) throw new GitCommandFailure('git/conflict', 'conflict', { operation: 'merge' })
      return {}
    }),
  )
  expect(failure.code).toBe('git/conflict')
  expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(true)
  return ctx
}

function resolve(repo: TempRepo, path: string, content: string): void {
  repo.write(path, content)
  repo.git('add', path)
}

describe('readOperationState', () => {
  it('describes HEAD when no operation is in progress', async () => {
    const repo = makeRepo()
    const value = await state(repo)
    expect(value).toEqual({
      operation: null,
      ours: { label: 'main', ref: 'refs/heads/main', sha: sha(repo, 'HEAD') },
      theirs: { label: '' },
      conflicts: [],
      resolved: [],
      pendingStash: false,
    })
  })

  it('names both sides of a merge, its message, conflicts and resolved paths', async () => {
    const repo = makeRepo()
    conflictingBranches(repo)
    repo.gitResult('merge', '--no-edit', 'feature')
    resolve(repo, 'a.txt', 'resolved a\n')

    const value = await state(repo)

    expect(value.operation).toBe('merge')
    expect(value.ours).toEqual({ label: 'main', ref: 'refs/heads/main', sha: sha(repo, 'HEAD') })
    expect(value.theirs).toEqual({ label: 'feature', ref: 'refs/heads/feature', sha: sha(repo, 'feature') })
    expect(value.message).toBe("Merge branch 'feature'")
    expect(value.conflicts).toEqual([{ path: 'b.txt', status: 'U', conflict: 'both-modified' }])
    expect(value.resolved).toEqual(['a.txt', 'c.txt'])
    expect(value.pendingStash).toBe(false)
    expect(value.step).toBeUndefined()
  })

  it('falls back to the short hash when MERGE_MSG names no branch', async () => {
    const repo = makeRepo()
    conflictingBranches(repo)
    const feature = sha(repo, 'feature')
    repo.gitResult('merge', '--no-edit', feature)

    const value = await state(repo)

    expect(value.theirs).toEqual({ label: short(repo, feature), sha: feature })
  })

  it('reports rebase progress 2/3 with onto (ours) and head-name (theirs)', async () => {
    const repo = makeRepo()
    repo.write('shared.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('one.txt', '1\n')
    repo.commit('feature 1')
    repo.write('shared.txt', 'feature\n')
    repo.commit('feature 2')
    repo.write('three.txt', '3\n')
    repo.commit('feature 3')
    repo.git('checkout', '-q', 'main')
    repo.write('shared.txt', 'main\n')
    repo.commit('main change')
    repo.git('checkout', '-q', 'feature')
    repo.gitResult('rebase', 'main')

    const value = await state(repo)

    expect(value.operation).toBe('rebase')
    expect(value.step).toEqual({ current: 2, total: 3 })
    expect(value.ours).toEqual({ label: 'main', ref: 'refs/heads/main', sha: sha(repo, 'main') })
    expect(value.theirs.label).toBe('feature')
    expect(value.theirs.ref).toBe('refs/heads/feature')
    expect(value.theirs.sha).toBe(sha(repo, 'feature~1'))
    expect(value.conflicts.map((entry) => entry.path)).toEqual(['shared.txt'])

    const status = await readStatus(runner, repo.root, {})
    expect(status.operationStep).toEqual({ current: 2, total: 3 })
  })

  it('labels a cherry-pick: ours is the current branch, theirs the picked commit', async () => {
    const repo = makeRepo()
    conflictingBranches(repo)
    const picked = sha(repo, 'feature')
    repo.gitResult('cherry-pick', picked)

    const value = await state(repo)

    expect(value.operation).toBe('cherry-pick')
    expect(value.ours).toEqual({ label: 'main', ref: 'refs/heads/main', sha: sha(repo, 'HEAD') })
    expect(value.theirs).toEqual({ label: short(repo, picked), sha: picked })
    expect((await readStatus(runner, repo.root, {})).operationStep).toBeUndefined()
  })

  it('labels a revert: theirs is the reverted commit', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'one\n')
    const first = repo.commit('one')
    repo.write('a.txt', 'two\n')
    repo.commit('two')
    repo.gitResult('revert', '--no-edit', first)

    const value = await state(repo)

    expect(value.operation).toBe('revert')
    expect(value.ours.label).toBe('main')
    expect(value.theirs).toEqual({ label: short(repo, first), sha: first })
  })

  it('reports a pending smart stash', async () => {
    const repo = makeRepo()
    await smartMergeStopped(repo)
    expect((await state(repo)).pendingStash).toBe(true)
  })
})

describe('operationControlOperation.parse', () => {
  it('accepts continue / skip / abort only', () => {
    const parse = (action: unknown) => () => operationControlOperation.parse({ action })
    expect(codeOf(parse('continue'))).toBe('ok')
    expect(codeOf(parse('skip'))).toBe('ok')
    expect(codeOf(parse('abort'))).toBe('ok')
    expect(codeOf(parse('quit'))).toBe('git/invalid-payload')
    expect(codeOf(parse(undefined))).toBe('git/invalid-payload')
  })
})

describe('operationControlOperation / merge', () => {
  it('abort ends the merge, restores the stash by sha and deletes the marker', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)

    const value = await control(ctx, 'abort')

    expect(value).toEqual({ operation: null, head: sha(repo, 'HEAD'), stashRestored: true })
    expect(existsSync(join(gitDir(repo), 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# my uncommitted edit\n')
    expect(stashShas(repo)).toEqual([])
    expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(false)
  })

  it('refuses continue while conflicts remain', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    resolve(repo, 'a.txt', 'resolved a\n')

    const failure = await failureOf(control(ctx, 'continue'))

    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', conflicts: 1 })
    expect(existsSync(join(gitDir(repo), 'MERGE_HEAD'))).toBe(true)
    expect(stashShas(repo)).toHaveLength(1)
  })

  it('continue commits the merge without an editor, then restores the stash', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    const main = sha(repo, 'HEAD')
    resolve(repo, 'a.txt', 'resolved a\n')
    resolve(repo, 'b.txt', 'resolved b\n')

    const value = await control(ctx, 'continue')

    expect(value).toMatchObject({ operation: null, stashRestored: true })
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toEqual([main, sha(repo, 'feature')])
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe("Merge branch 'feature'")
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# my uncommitted edit\n')
    expect(stashShas(repo)).toEqual([])
  })

  it('answers stashMissing when the user dropped the stash meanwhile', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    repo.git('stash', 'drop', '-q')

    const value = await control(ctx, 'abort')

    expect(value).toMatchObject({ operation: null, stashMissing: true })
    expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(false)
  })

  it('refuses skip outside a rebase or cherry-pick', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    const failure = await failureOf(control(ctx, 'skip'))
    expect(failure.code).toBe('git/invalid-payload')
    expect(stashShas(repo)).toHaveLength(1)
  })

  it('refuses control without an operation in progress', async () => {
    const repo = makeRepo()
    const failure = await failureOf(control(contextFor(repo), 'abort'))
    expect(failure.code).toBe('git/invalid-payload')
  })

  it('continue restores a pending stash left behind when the operation ended elsewhere', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    // The user aborted in a terminal: the marker is still there.
    repo.git('merge', '--abort')

    const value = await control(ctx, 'continue')

    expect(value).toMatchObject({ operation: null, stashRestored: true })
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# my uncommitted edit\n')
  })
})

describe('operationControlOperation / rebase', () => {
  /** feature has two commits that both conflict with main. */
  function twoConflicts(repo: TempRepo): void {
    repo.write('x.txt', 'base x\n')
    repo.write('y.txt', 'base y\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('x.txt', 'feature x\n')
    repo.commit('feature x')
    repo.write('y.txt', 'feature y\n')
    repo.commit('feature y')
    repo.git('checkout', '-q', 'main')
    repo.write('x.txt', 'main x\n')
    repo.write('y.txt', 'main y\n')
    repo.commit('main change')
    repo.git('checkout', '-q', 'feature')
    repo.gitResult('rebase', 'main')
  }

  it('continue stops on the next conflict with git/conflict, then skip finishes', async () => {
    const repo = makeRepo()
    twoConflicts(repo)
    const ctx = contextFor(repo)
    resolve(repo, 'x.txt', 'resolved x\n')

    const failure = await failureOf(control(ctx, 'continue'))

    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'rebase', conflicts: 1 })
    expect((await state(repo)).step).toEqual({ current: 2, total: 2 })

    const value = await control(ctx, 'skip')
    expect(value.operation).toBeNull()
    expect(repo.git('log', '--format=%s', 'main..feature').trim()).toBe('feature x')
    expect(readFileSync(join(repo.root, 'x.txt'), 'utf8')).toBe('resolved x\n')
  })

  it('abort returns to the original branch tip', async () => {
    const repo = makeRepo()
    twoConflicts(repo)
    const before = sha(repo, 'refs/heads/feature')
    const value = await control(contextFor(repo), 'abort')
    expect(value).toEqual({ operation: null, head: before })
    expect(repo.git('symbolic-ref', '--short', 'HEAD').trim()).toBe('feature')
  })
})

describe('operationControlOperation / cherry-pick and revert', () => {
  it('cherry-pick continue commits without an editor', async () => {
    const repo = makeRepo()
    conflictingBranches(repo)
    repo.gitResult('cherry-pick', 'feature')
    resolve(repo, 'a.txt', 'picked a\n')
    resolve(repo, 'b.txt', 'picked b\n')

    const value = await control(contextFor(repo), 'continue')

    expect(value.operation).toBeNull()
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('feature change')
  })

  it('cherry-pick skip drops the commit', async () => {
    const repo = makeRepo()
    conflictingBranches(repo)
    const main = sha(repo, 'HEAD')
    repo.gitResult('cherry-pick', 'feature')

    const value = await control(contextFor(repo), 'skip')

    expect(value).toEqual({ operation: null, head: main })
  })

  it('revert continue commits without an editor', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'one\n')
    const first = repo.commit('one')
    repo.write('a.txt', 'two\n')
    repo.commit('two')
    repo.gitResult('revert', '--no-edit', first)
    repo.write('a.txt', 'reverted by hand\n')
    repo.git('add', 'a.txt')

    const value = await control(contextFor(repo), 'continue')

    expect(value.operation).toBeNull()
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('Revert "one"')
  })

  it('refuses skip for a revert', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'one\n')
    const first = repo.commit('one')
    repo.write('a.txt', 'two\n')
    repo.commit('two')
    repo.gitResult('revert', '--no-edit', first)
    expect((await failureOf(control(contextFor(repo), 'skip'))).code).toBe('git/invalid-payload')
  })
})

describe('operationCommitOperation', () => {
  it('is only available during a merge', async () => {
    const repo = makeRepo()
    const failure = await failureOf(commitInOperation(contextFor(repo), 'msg'))
    expect(failure.code).toBe('git/invalid-payload')
  })

  it('refuses while conflicts remain', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    const failure = await failureOf(commitInOperation(ctx, 'merge it'))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', conflicts: 2 })
  })

  it('commits everything staged (no pathspec) with the message from stdin, then restores the stash', async () => {
    const repo = makeRepo()
    const ctx = await smartMergeStopped(repo)
    const main = sha(repo, 'HEAD')
    resolve(repo, 'a.txt', 'resolved a\n')
    resolve(repo, 'b.txt', 'resolved b\n')
    const message = "Merge feature into main\n\nResolved a and b — 'quoted' \"too\""

    const value = await commitInOperation(ctx, message)

    expect(value.sha).toBe(sha(repo, 'HEAD'))
    expect(value.shortSha).toBe(value.sha.slice(0, value.shortSha.length))
    expect(value.stashRestored).toBe(true)
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe(message)
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toEqual([main, sha(repo, 'feature')])
    // The auto-merged c.txt is part of the commit: no pathspec narrowed it.
    expect(repo.git('diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').filter(Boolean).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ])
    expect(existsSync(join(gitDir(repo), 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# my uncommitted edit\n')
  })
})
