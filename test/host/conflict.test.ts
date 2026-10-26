// A3 T3：逐文件解决冲突（真实临时仓库）。ours/theirs 的方向按文件「内容」断言：
// 合并与拣选 ours = 当前分支，变基 ours = 目标分支（onto），都要和 operationState 的标签一致。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { conflictCommandFor, resolveConflictOperation } from '../../src/host/git/conflict.ts'
import { readOperationState } from '../../src/host/git/operation.ts'
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

async function resolveConflict(ctx: WriteContext, path: string, resolution: string, force?: boolean) {
  const op = resolveConflictOperation
  return await op.run(
    ctx,
    op.parse({ sessionId: 's', requestId: 'r', path, resolution, ...(force === undefined ? {} : { force }) }),
  )
}

function read(repo: TempRepo, path: string): string {
  return readFileSync(join(repo.root, path), 'utf8')
}

function exists(repo: TempRepo, path: string): boolean {
  return existsSync(join(repo.root, path))
}

/** Porcelain v1 XY of one path ('' when clean). */
function xy(repo: TempRepo, path: string): string {
  return repo.git('status', '--porcelain=v1', '-z', '--', path).split('\0')[0]?.slice(0, 2) ?? ''
}

async function labels(repo: TempRepo): Promise<{ ours: string; theirs: string }> {
  const state = await readOperationState(runner, repo.root, {})
  return { ours: state.ours.label, theirs: state.theirs.label }
}

/**
 * main and feature both edit the shared files with side-named content; feature deletes
 * ud.txt (main edits it), main deletes du.txt (feature edits it); both add aa.txt.
 */
const SHARED = ['uu.txt', '-dash.txt', '冲突 文件.txt'] as const

function divergedBranches(repo: TempRepo): void {
  for (const path of [...SHARED, 'ud.txt', 'du.txt']) repo.write(path, `base ${path}\n`)
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  for (const path of SHARED) repo.write(path, `feature ${path}\n`)
  repo.write('du.txt', 'feature du\n')
  repo.git('rm', '-q', 'ud.txt')
  repo.write('aa.txt', 'feature aa\n')
  repo.commit('feature side')
  repo.git('checkout', '-q', 'main')
  for (const path of SHARED) repo.write(path, `main ${path}\n`)
  repo.write('ud.txt', 'main ud\n')
  repo.git('rm', '-q', 'du.txt')
  repo.write('aa.txt', 'main aa\n')
  repo.commit('main side')
}

function mergeStopped(repo: TempRepo): void {
  divergedBranches(repo)
  expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
}

describe('resolveConflictOperation.parse', () => {
  it('validates path, resolution and force', () => {
    const parse = (payload: Record<string, unknown>) => () =>
      resolveConflictOperation.parse({ sessionId: 's', requestId: 'r', ...payload })
    expect(codeOf(parse({ path: 'a.txt', resolution: 'ours' }))).toBe('ok')
    expect(codeOf(parse({ path: '../a.txt', resolution: 'ours' }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ path: 'a.txt', resolution: 'mine' }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ path: 'a.txt', resolution: 'mark-resolved', force: 'yes' }))).toBe('git/invalid-payload')
  })
})

describe('resolveConflict during a merge', () => {
  it('takes the side named by the operation labels (ours = current branch)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    expect(await labels(repo)).toEqual({ ours: 'main', theirs: 'feature' })
    const ctx = contextFor(repo)
    expect(await resolveConflict(ctx, 'uu.txt', 'ours')).toMatchObject({ path: 'uu.txt' })
    expect(read(repo, 'uu.txt')).toBe('main uu.txt\n')
    expect(xy(repo, 'uu.txt')).toBe('')
    await resolveConflict(ctx, '-dash.txt', 'theirs')
    expect(read(repo, '-dash.txt')).toBe('feature -dash.txt\n')
    expect(xy(repo, '-dash.txt')).toBe('M ')
    await resolveConflict(ctx, '冲突 文件.txt', 'theirs')
    expect(read(repo, '冲突 文件.txt')).toBe('feature 冲突 文件.txt\n')
    const both = await resolveConflict(ctx, 'aa.txt', 'theirs')
    expect(read(repo, 'aa.txt')).toBe('feature aa\n')
    // ud.txt and du.txt remain.
    expect(both.remaining).toBe(2)
  })

  it('handles deleted-by-them / deleted-by-us: keep one side or delete', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    // UD: we modified, they deleted. Ours keeps our content; theirs = deletion.
    await resolveConflict(ctx, 'ud.txt', 'ours')
    expect(read(repo, 'ud.txt')).toBe('main ud\n')
    expect(xy(repo, 'ud.txt')).toBe('')
    // DU: we deleted, they modified. Ours = deletion.
    const value = await resolveConflict(ctx, 'du.txt', 'ours')
    expect(exists(repo, 'du.txt')).toBe(false)
    expect(xy(repo, 'du.txt')).toBe('')
    expect(value.remaining).toBe(4)
  })

  it('theirs on deleted-by-them deletes; delete removes a modified conflict', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await resolveConflict(ctx, 'ud.txt', 'theirs')
    expect(exists(repo, 'ud.txt')).toBe(false)
    expect(xy(repo, 'ud.txt')).toBe('D ')
    await resolveConflict(ctx, 'du.txt', 'theirs')
    expect(read(repo, 'du.txt')).toBe('feature du\n')
    expect(xy(repo, 'du.txt')).toBe('A ')
    await resolveConflict(ctx, 'uu.txt', 'delete')
    expect(exists(repo, 'uu.txt')).toBe(false)
    expect(xy(repo, 'uu.txt')).toBe('D ')
  })

  it('mark-resolved refuses leftover conflict markers unless forced', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const failure = await failureOf(resolveConflict(ctx, '冲突 文件.txt', 'mark-resolved'))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ markers: true })
    expect(xy(repo, '冲突 文件.txt')).toBe('UU')
    await resolveConflict(ctx, '冲突 文件.txt', 'mark-resolved', true)
    expect(read(repo, '冲突 文件.txt')).toContain('<<<<<<<')
    expect(xy(repo, '冲突 文件.txt')).toBe('M ')

    repo.write('uu.txt', 'hand merged\n')
    await resolveConflict(ctx, 'uu.txt', 'mark-resolved')
    expect(xy(repo, 'uu.txt')).toBe('M ')
    expect(repo.git('show', ':uu.txt')).toBe('hand merged\n')
  })

  it('refuses a path that is not in the current conflict list (stale-target)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await resolveConflict(ctx, 'uu.txt', 'ours')
    for (const path of ['uu.txt', 'README.md', 'missing.txt']) {
      const failure = await failureOf(resolveConflict(ctx, path, 'theirs'))
      expect(failure.code).toBe('git/stale-target')
      expect(failure.details).toMatchObject({ target: 'conflict', expected: path })
    }
    expect(read(repo, 'uu.txt')).toBe('main uu.txt\n')
  })
})

describe('ours/theirs direction in other operations', () => {
  it('rebase: ours is the target branch (onto), theirs the replayed branch', async () => {
    const repo = makeRepo()
    divergedBranches(repo)
    repo.git('checkout', '-q', 'feature')
    expect(repo.gitResult('rebase', 'main').status).not.toBe(0)
    expect(await labels(repo)).toEqual({ ours: 'main', theirs: 'feature' })
    const ctx = contextFor(repo)
    await resolveConflict(ctx, 'uu.txt', 'ours')
    expect(read(repo, 'uu.txt')).toBe('main uu.txt\n')
    await resolveConflict(ctx, '-dash.txt', 'theirs')
    expect(read(repo, '-dash.txt')).toBe('feature -dash.txt\n')
  })

  it('cherry-pick: ours is the current branch, theirs the picked commit', async () => {
    const repo = makeRepo()
    divergedBranches(repo)
    expect(repo.gitResult('cherry-pick', 'feature').status).not.toBe(0)
    const sides = await labels(repo)
    expect(sides.ours).toBe('main')
    expect(sides.theirs).toBe(repo.git('rev-parse', '--short', 'feature').trim())
    const ctx = contextFor(repo)
    await resolveConflict(ctx, 'uu.txt', 'ours')
    expect(read(repo, 'uu.txt')).toBe('main uu.txt\n')
    await resolveConflict(ctx, '冲突 文件.txt', 'theirs')
    expect(read(repo, '冲突 文件.txt')).toBe('feature 冲突 文件.txt\n')
  })

  it('revert: ours is the current branch, theirs the reverted commit parent side', async () => {
    const repo = makeRepo()
    repo.write('r.txt', 'one\n')
    repo.commit('one')
    repo.write('r.txt', 'two\n')
    const target = repo.commit('two')
    repo.write('r.txt', 'three\n')
    repo.commit('three')
    expect(repo.gitResult('revert', '--no-edit', target).status).not.toBe(0)
    const sides = await labels(repo)
    expect(sides.ours).toBe('main')
    await resolveConflict(contextFor(repo), 'r.txt', 'theirs')
    // Reverting "two" means taking the state before it.
    expect(read(repo, 'r.txt')).toBe('one\n')
  })
})

describe('conflictCommandFor', () => {
  it('quotes the repository and suggests status + mergetool', () => {
    expect(conflictCommandFor('/work/my repo')).toEqual({
      command: "cd '/work/my repo' && git status && git mergetool",
    })
  })
})
