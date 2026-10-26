// A3 T2：智能贮藏（真实临时仓库）。脏工作区先问、贮藏→操作→`pop --index` 恢复、
// 停在冲突时贮藏保留并写待恢复标记（Host 重启后仍可恢复）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DIRTY_PATHS_LIMIT } from '../../src/shared/protocol.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { pendingStashPath, readPendingStash, restorePendingStash, withSmartStash } from '../../src/host/git/smart-stash.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

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

/** `feature` and `main` both edit shared.txt (conflicting) or separate files. */
function branches(repo: TempRepo, conflicting: boolean): void {
  repo.write('shared.txt', 'base\n')
  repo.commit('shared base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write(conflicting ? 'shared.txt' : 'feature.txt', 'feature\n')
  repo.commit('feature change')
  repo.git('checkout', '-q', 'main')
  repo.write(conflicting ? 'shared.txt' : 'main.txt', 'main\n')
  repo.commit('main change')
}

/** The "operation" a T4 endpoint would run: merge feature, `git/conflict` when it stops. */
function mergeFeature(ctx: WriteContext): () => Promise<{ head: string }> {
  return async () => {
    const result = await ctx.git([...GIT_BASE_ARGV, 'merge', '--no-edit', 'feature'])
    if (result.exitCode !== 0) {
      throw new GitCommandFailure('git/conflict', 'merge stopped with conflicts', { operation: 'merge' })
    }
    return { head: 'merged' }
  }
}

function statusLines(repo: TempRepo): string[] {
  return repo.git('status', '--porcelain').split('\n').filter(Boolean).sort()
}

function stashShas(repo: TempRepo): string[] {
  return repo.git('stash', 'list', '--format=%H').split('\n').filter(Boolean)
}

function gitDir(repo: TempRepo): string {
  return repo.git('rev-parse', '--absolute-git-dir').trim()
}

describe('withSmartStash / dirty worktree', () => {
  it('refuses tracked changes without stash: true and never runs the operation', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('README.md', '# edited\n')
    repo.write('untracked.txt', 'new\n')
    const run = vi.fn(async () => ({ head: 'x' }))

    const failure = await failureOf(withSmartStash(contextFor(repo), { stash: false, operation: 'merge' }, run))

    expect(failure.code).toBe('git/dirty-worktree')
    expect(failure.details).toEqual({ operation: 'merge', paths: ['README.md'], count: 1 })
    expect(run).not.toHaveBeenCalled()
    expect(stashShas(repo)).toEqual([])
  })

  it(`lists at most ${String(DIRTY_PATHS_LIMIT)} paths but counts them all`, async () => {
    const repo = makeRepo()
    for (let index = 0; index < 60; index += 1) repo.write(`f-${String(index).padStart(2, '0')}.txt`, 'a\n')
    repo.commit('many files')
    for (let index = 0; index < 60; index += 1) repo.write(`f-${String(index).padStart(2, '0')}.txt`, 'b\n')

    const failure = await failureOf(
      withSmartStash(contextFor(repo), { stash: false, operation: 'rebase' }, async () => ({})),
    )

    expect(failure.code).toBe('git/dirty-worktree')
    expect((failure.details?.paths as string[]).length).toBe(DIRTY_PATHS_LIMIT)
    expect(failure.details?.count).toBe(60)
  })

  it('runs directly when only untracked files exist (no stash made)', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('untracked.txt', 'new\n')
    const ctx = contextFor(repo)

    const result = await withSmartStash(ctx, { stash: false, operation: 'merge' }, mergeFeature(ctx))

    expect(result.value).toEqual({ head: 'merged' })
    expect(result.outcome).toEqual({})
    expect(stashShas(repo)).toEqual([])
    expect(existsSync(join(repo.root, 'untracked.txt'))).toBe(true)
  })
})

describe('withSmartStash / stash and restore', () => {
  it('stashes, merges and restores staged vs unstaged exactly', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('staged.txt', 'staged\n')
    repo.git('add', 'staged.txt')
    repo.write('README.md', '# unstaged\n')
    repo.write('main.txt', 'main staged\n')
    repo.git('add', 'main.txt')
    repo.write('main.txt', 'main staged then edited\n')
    const before = statusLines(repo)
    const ctx = contextFor(repo)

    let stashMessage = ''
    const result = await withSmartStash(ctx, { stash: true, operation: 'merge' }, async () => {
      stashMessage = repo.git('stash', 'list', '--format=%gs').trim()
      // The operation sees a clean tracked worktree.
      expect(repo.git('status', '--porcelain', '--untracked-files=no').trim()).toBe('')
      return await mergeFeature(ctx)()
    })

    expect(stashMessage).toBe('On main: dsh-git: before merge')
    expect(result.outcome).toEqual({ stashRestored: true })
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    expect(statusLines(repo)).toEqual(before)
    expect(repo.git('diff', '--cached', '--', 'main.txt')).toContain('+main staged')
    expect(stashShas(repo)).toEqual([])
    expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(false)
  })

  it('restores the stash when the operation fails without starting (original error kept)', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)

    const failure = await failureOf(
      withSmartStash(ctx, { stash: true, operation: 'merge' }, async () => {
        throw new GitCommandFailure('git/invalid-payload', 'unknown revision', {})
      }),
    )

    expect(failure.code).toBe('git/invalid-payload')
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# dirty\n')
    expect(stashShas(repo)).toEqual([])
  })

  it('keeps the stash and records it when the operation stops on conflicts', async () => {
    const repo = makeRepo()
    branches(repo, true)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)

    const failure = await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))

    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', stashKept: true })
    const [sha] = stashShas(repo)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const pending = await readPendingStash(gitDir(repo))
    expect(pending).toMatchObject({ stashSha: sha, operation: 'merge' })
    expect(Number.isNaN(Date.parse(pending?.createdAt ?? ''))).toBe(false)
    // The marker is a plain file under <gitDir>/dsh-git: it survives a Host restart.
    expect(JSON.parse(readFileSync(join(gitDir(repo), 'dsh-git', 'pending-stash.json'), 'utf8'))).toMatchObject({
      stashSha: sha,
    })
  })

  it('keeps the stash pending when the operation succeeds but leaves an operation open (--no-commit)', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)

    const result = await withSmartStash(ctx, { stash: true, operation: 'merge' }, async () => {
      const merged = await ctx.git([...GIT_BASE_ARGV, 'merge', '--no-commit', '--no-ff', 'feature'])
      expect(merged.exitCode).toBe(0)
      return {}
    })

    expect(result.outcome).toEqual({ stashKept: true })
    expect(stashShas(repo)).toHaveLength(1)
    expect(await readPendingStash(gitDir(repo))).toMatchObject({ operation: 'merge' })
  })

  it('reports git/conflict with stashKept when restoring conflicts with the result', async () => {
    const repo = makeRepo()
    repo.write('shared.txt', 'base\n')
    repo.commit('shared base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('shared.txt', 'feature\n')
    repo.commit('feature edits shared')
    repo.git('checkout', '-q', 'main')
    repo.write('main.txt', 'main\n')
    repo.commit('main change')
    // Uncommitted edit to the file the merge changes: the merge itself is clean, the pop is not.
    repo.write('shared.txt', 'local edit\n')
    const ctx = contextFor(repo)

    const failure = await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))

    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ stashKept: true })
    expect(stashShas(repo)).toHaveLength(1)
  })
})

describe('restorePendingStash', () => {
  it('does nothing without a marker', async () => {
    const repo = makeRepo()
    expect(await restorePendingStash(contextFor(repo))).toEqual({})
  })

  it('restores by sha even when other stashes were pushed on top, then deletes the marker', async () => {
    const repo = makeRepo()
    branches(repo, true)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)
    await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))
    repo.git('merge', '--abort')
    // Someone else stashes something meanwhile: ours is now stash@{1}.
    repo.write('shared.txt', 'other\n')
    repo.git('stash', 'push', '-q', '-m', 'unrelated')
    const unrelated = stashShas(repo)[0]

    const outcome = await restorePendingStash(ctx)

    expect(outcome).toEqual({ stashRestored: true })
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# dirty\n')
    expect(stashShas(repo)).toEqual([unrelated])
    expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(false)
  })

  it('answers stashMissing (not an error) when the user dropped the stash', async () => {
    const repo = makeRepo()
    branches(repo, true)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)
    await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))
    repo.git('merge', '--abort')
    repo.git('stash', 'drop', '-q')

    expect(await restorePendingStash(ctx)).toEqual({ stashMissing: true })
    expect(existsSync(pendingStashPath(gitDir(repo)))).toBe(false)
  })

  it('ignores a corrupt marker without touching the stash list', async () => {
    const repo = makeRepo()
    repo.write('README.md', '# dirty\n')
    repo.git('stash', 'push', '-q')
    mkdirSync(join(gitDir(repo), 'dsh-git'), { recursive: true })
    writeFileSync(pendingStashPath(gitDir(repo)), '{not json', 'utf8')

    expect(await readPendingStash(gitDir(repo))).toBeUndefined()
    expect(await restorePendingStash(contextFor(repo))).toEqual({})
    expect(stashShas(repo)).toHaveLength(1)
  })
})
