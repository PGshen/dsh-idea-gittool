// A3 T2：智能贮藏（真实临时仓库）。脏工作区先问、贮藏→操作→`pop --index` 恢复、
// 停在冲突时贮藏保留并写待恢复标记（Host 重启后仍可恢复）。
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DIRTY_PATHS_LIMIT } from '../../src/shared/protocol.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import {
  PENDING_STASH_META_REF,
  PENDING_STASH_REF,
  queryOf,
  readPendingStash,
  restorePendingStash,
  withSmartStash,
} from '../../src/host/git/smart-stash.ts'
import { createTempDir, createTempRepo, removeTempDir } from './fixtures.ts'
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

function hasMarker(repo: TempRepo): boolean {
  return repo.gitResult('rev-parse', '-q', '--verify', PENDING_STASH_REF).status === 0
}

async function pendingOf(repo: TempRepo) {
  return await readPendingStash(queryOf(contextFor(repo)))
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
    expect(hasMarker(repo)).toBe(false)
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
    const pending = await pendingOf(repo)
    expect(pending).toMatchObject({
      stashSha: sha,
      operation: 'merge',
      branch: 'refs/heads/main',
      headSha: repo.git('rev-parse', 'HEAD').trim(),
    })
    expect(Number.isNaN(Date.parse(pending?.createdAt ?? ''))).toBe(false)
    // The marker is a per-worktree ref (survives a Host restart, keeps the stash reachable)
    // and never shows up among branches, remotes or tags.
    expect(repo.git('rev-parse', PENDING_STASH_REF).trim()).toBe(sha)
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags')).not.toContain(
      'dsh-git',
    )
    expect(existsSync(join(gitDir(repo), 'dsh-git'))).toBe(false)
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
    expect(await pendingOf(repo)).toMatchObject({ operation: 'merge' })
  })

  it('answers stashMissing (not stashRestored) when the stash vanished during the operation (T3 fix)', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('README.md', '# edited\n')
    const ctx = contextFor(repo)

    const result = await withSmartStash(ctx, { stash: true, operation: 'checkout' }, async () => {
      repo.git('stash', 'drop', '-q')
      return 'done'
    })

    expect(result.outcome).toEqual({ stashMissing: true })
    expect(stashShas(repo)).toEqual([])
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

  it('reports success with stashKept + stashError (not git/conflict) when the restore fails without conflicts (final review 2c)', async () => {
    const repo = makeRepo()
    branches(repo, false)
    repo.write('README.md', '# stashed edit\n')
    const ctx = contextFor(repo)

    // The operation leaves an unstaged edit to the stashed file: `stash pop` refuses to
    // overwrite it ("local changes would be overwritten"), which is not a conflict.
    const result = await withSmartStash(ctx, { stash: true, operation: 'checkout' }, async () => {
      repo.write('README.md', '# changed by the operation\n')
      return 'done'
    })

    expect(result.value).toBe('done')
    expect(result.outcome).toMatchObject({ stashKept: true })
    expect(result.outcome.stashError).toEqual(expect.any(String))
    expect(repo.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('')
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
    expect(hasMarker(repo)).toBe(false)
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
    expect(hasMarker(repo)).toBe(false)
  })

  it('ignores a corrupt marker without touching the stash list', async () => {
    const repo = makeRepo()
    repo.write('README.md', '# dirty\n')
    repo.git('stash', 'push', '-q')
    const blob = repo.git('hash-object', '-w', '--stdin').trim() // empty stdin: not JSON
    repo.git('update-ref', PENDING_STASH_REF, stashShas(repo)[0] ?? '')
    repo.git('update-ref', PENDING_STASH_META_REF, blob)

    expect(await pendingOf(repo)).toBeUndefined()
    expect(await restorePendingStash(contextFor(repo))).toEqual({})
    expect(stashShas(repo)).toHaveLength(1)
  })
})

describe('pending marker is written only through confined git (评审 I1)', () => {
  it('never follows a symlink planted under .git and writes markers only with write-mode git', async () => {
    const repo = makeRepo()
    branches(repo, true)
    repo.write('README.md', '# dirty\n')
    const outside = createTempDir('dsh-git-outside-')
    cleanups.push(() => removeTempDir(outside))
    // What a sandboxed agent could plant: the former marker location pointing outside.
    symlinkSync(outside, join(gitDir(repo), 'dsh-git'))
    const base = contextFor(repo)
    const calls: Array<{ args: string[]; mode: string }> = []
    const ctx: WriteContext = {
      ...base,
      git: async (argv, options) => {
        calls.push({ args: argv.slice(GIT_BASE_ARGV.length), mode: options?.mode ?? 'write' })
        return await base.git(argv, options)
      },
    }

    await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))
    repo.git('merge', '--abort')
    expect(await restorePendingStash(ctx)).toEqual({ stashRestored: true })

    expect(readdirSync(outside)).toEqual([])
    const markerWrites = calls.filter(({ args }) => args[0] === 'update-ref' || args[0] === 'hash-object')
    expect(markerWrites.map(({ args }) => args[0])).toEqual(['hash-object', 'update-ref', 'update-ref'])
    expect(markerWrites.every(({ mode }) => mode === 'write')).toBe(true)
  })

  it('has no Host-side filesystem writes on the marker path', () => {
    for (const file of ['smart-stash.ts', 'operation.ts']) {
      const source = readFileSync(join(import.meta.dirname, '../../src/host/git', file), 'utf8')
      expect(source, file).not.toMatch(/from 'node:fs(\/promises)?'/)
    }
  })
})

describe('restorePendingStash / belongs to the branch it was made on (评审 M1)', () => {
  it('keeps the stash (no pop) when HEAD is now on another branch', async () => {
    const repo = makeRepo()
    branches(repo, true)
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)
    await failureOf(withSmartStash(ctx, { stash: true, operation: 'merge' }, mergeFeature(ctx)))
    repo.git('merge', '--abort')
    repo.git('checkout', '-q', 'feature')

    expect(await restorePendingStash(ctx)).toEqual({ stashKept: true })
    expect(readFileSync(join(repo.root, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect(stashShas(repo)).toHaveLength(1)
    expect(hasMarker(repo)).toBe(true)
  })
})

describe('withSmartStash / original error preserved (评审 M2)', () => {
  it('reports the operation failure, not the restore conflict, with stashKept merged in', async () => {
    const repo = makeRepo()
    repo.write('README.md', '# dirty\n')
    const ctx = contextFor(repo)

    const failure = await failureOf(
      withSmartStash(ctx, { stash: true, operation: 'merge' }, async () => {
        // The failed step still moved README.md, so putting the edit back conflicts.
        repo.write('README.md', '# moved by the operation\n')
        repo.commit('moved')
        throw new GitCommandFailure('git/hook-failed', 'blocked by a hook', { output: 'nope' })
      }),
    )

    expect(failure.code).toBe('git/hook-failed')
    expect(failure.message).toBe('blocked by a hook')
    expect(failure.details).toMatchObject({ output: 'nope', stashKept: true })
    expect(stashShas(repo)).toHaveLength(1)
  })
})
