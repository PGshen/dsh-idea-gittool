// A3 T4：集成操作（真实临时仓库）。合并三种选项与冲突、变基、拣选/回滚（合并提交拒绝）、
// 重置三模式与预览；脏工作区走智能贮藏，贮藏永不丢；用户输入不能被当成选项。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WriteContext } from '../../src/host/git-executor.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import {
  cherryPickOperation,
  mergeOperation,
  readResetPreview,
  rebaseOperation,
  resetOperation,
  revertCommitOperation,
} from '../../src/host/git/integrate.ts'
import { PENDING_STASH_REF } from '../../src/host/git/smart-stash.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo, writeExecutableScript } from './fixtures.ts'
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

function codeOf(parse: () => unknown): string {
  try {
    parse()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  return 'ok'
}

interface Op<V> {
  parse(payload: unknown): unknown
  run(ctx: WriteContext, input: never): Promise<V>
}

async function run<V>(op: Op<V>, repo: TempRepo, payload: Record<string, unknown>): Promise<V> {
  const input = op.parse({ sessionId: 's', requestId: 'r', ...payload })
  return await op.run(contextFor(repo), input as never)
}

const sha = (repo: TempRepo, rev = 'HEAD'): string => repo.git('rev-parse', rev).trim()
const read = (repo: TempRepo, path: string): string => readFileSync(join(repo.root, path), 'utf8')
const stashCount = (repo: TempRepo): number => repo.git('stash', 'list').split('\n').filter(Boolean).length

/** main and feature diverged; `conflicting` makes both edit shared.txt. */
function diverged(repo: TempRepo, conflicting = false): { feature: string; main: string } {
  repo.write('shared.txt', 'base\n')
  repo.commit('shared base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write(conflicting ? 'shared.txt' : 'feature.txt', 'feature\n')
  const feature = repo.commit('feature work')
  repo.git('checkout', '-q', 'main')
  repo.write(conflicting ? 'shared.txt' : 'main.txt', 'main\n')
  const main = repo.commit('main work')
  return { feature, main }
}

describe('parse (user input never becomes an option)', () => {
  it('validates merge, rebase, cherry-pick, revert and reset payloads', () => {
    expect(codeOf(() => mergeOperation.parse({ ref: '--abort' }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeOperation.parse({ ref: 'feature', squash: true, noFf: true }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeOperation.parse({ ref: 'feature', stash: 'yes' }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeOperation.parse({ ref: 'feature', noCommit: true }))).toBe('ok')
    expect(codeOf(() => rebaseOperation.parse({ onto: '-i' }))).toBe('git/invalid-payload')
    expect(codeOf(() => cherryPickOperation.parse({ sha: 'abc123' }))).toBe('git/invalid-payload')
    expect(codeOf(() => revertCommitOperation.parse({ sha: 'HEAD' }))).toBe('git/invalid-payload')
    expect(codeOf(() => resetOperation.parse({ sha: 'a'.repeat(40), mode: 'keep' }))).toBe('git/invalid-payload')
    expect(codeOf(() => resetOperation.parse({ sha: 'a'.repeat(40), mode: 'hard' }))).toBe('git/invalid-payload')
    expect(codeOf(() => resetOperation.parse({ sha: 'a'.repeat(40), mode: 'hard', confirmHard: true }))).toBe('ok')
    expect(codeOf(() => resetOperation.parse({ sha: 'a'.repeat(40), mode: 'soft', expectedHead: 'b' }))).toBe(
      'git/invalid-payload',
    )
  })
})

describe('merge', () => {
  it('creates a merge commit without opening an editor', async () => {
    const repo = makeRepo()
    const { feature, main } = diverged(repo)
    const value = await run(mergeOperation, repo, { ref: 'feature' })
    expect(value).toEqual({ head: sha(repo), committed: true })
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toEqual([main, feature])
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe("Merge branch 'feature'")
  })

  it('--no-ff records a merge commit even when a fast-forward is possible', async () => {
    const repo = makeRepo()
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('f.txt', 'f\n')
    const feature = repo.commit('f')
    repo.git('checkout', '-q', 'main')
    const before = sha(repo)
    await run(mergeOperation, repo, { ref: 'feature', noFf: true })
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toEqual([before, feature])
  })

  it('--squash leaves the changes staged and HEAD where it was', async () => {
    const repo = makeRepo()
    const { main } = diverged(repo)
    const value = await run(mergeOperation, repo, { ref: 'feature', squash: true })
    expect(value).toEqual({ head: main, committed: false })
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('feature.txt')
  })

  it('--no-commit stops in the merge state with the result staged', async () => {
    const repo = makeRepo()
    const { main } = diverged(repo)
    const value = await run(mergeOperation, repo, { ref: 'feature', noCommit: true })
    expect(value).toEqual({ head: main, committed: false })
    expect(existsSync(join(repo.root, '.git', 'MERGE_HEAD'))).toBe(true)
  })

  it('stops on conflicts in the merge state with git/conflict and a conflict count', async () => {
    const repo = makeRepo()
    diverged(repo, true)
    const failure = await failureOf(run(mergeOperation, repo, { ref: 'feature' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', conflicts: 1 })
    expect(existsSync(join(repo.root, '.git', 'MERGE_HEAD'))).toBe(true)
    // Another integrate operation is refused while the merge is open.
    const again = await failureOf(run(rebaseOperation, repo, { onto: 'feature' }))
    expect(again.code).toBe('git/operation-in-progress')
  })

  it('does not blame a hook for git refusing to overwrite an untracked file', async () => {
    const repo = makeRepo()
    diverged(repo)
    writeExecutableScript(join(repo.root, '.git', 'hooks'), 'pre-merge-commit', '#!/bin/sh\nexit 0\n')
    repo.write('feature.txt', 'untracked in the way\n')
    const failure = await failureOf(run(mergeOperation, repo, { ref: 'feature' }))
    expect(failure.code).toBe('git/exec-failed')
    expect(failure.message).toMatch(/untracked working tree files would be overwritten/)
    expect(read(repo, 'feature.txt')).toBe('untracked in the way\n')
  })

  it('rejects an unknown ref without touching the repository', async () => {
    const repo = makeRepo()
    const before = sha(repo)
    const failure = await failureOf(run(mergeOperation, repo, { ref: 'nope' }))
    expect(failure.code).toBe('git/invalid-payload')
    expect(sha(repo)).toBe(before)
  })
})

describe('smart stash around integrate operations', () => {
  it('refuses tracked changes without stash: true (dirty-worktree names the operation)', async () => {
    const repo = makeRepo()
    diverged(repo)
    repo.write('README.md', '# dirty\n')
    const before = sha(repo)
    for (const [op, payload, operation] of [
      [mergeOperation, { ref: 'feature' }, 'merge'],
      [rebaseOperation, { onto: 'feature' }, 'rebase'],
      [cherryPickOperation, { sha: sha(repo, 'feature') }, 'cherry-pick'],
      [revertCommitOperation, { sha: before }, 'revert'],
    ] as const) {
      const failure = await failureOf(run(op as Op<unknown>, repo, payload))
      expect({ code: failure.code, details: failure.details }).toEqual({
        code: 'git/dirty-worktree',
        details: { operation, paths: ['README.md'], count: 1 },
      })
    }
    expect(sha(repo)).toBe(before)
    expect(read(repo, 'README.md')).toBe('# dirty\n')
  })

  it('stashes, merges and restores staged and unstaged changes', async () => {
    const repo = makeRepo()
    diverged(repo)
    repo.write('README.md', '# unstaged\n')
    repo.write('main.txt', 'staged\n')
    repo.git('add', 'main.txt')
    const status = repo.git('status', '--porcelain')
    const value = await run(mergeOperation, repo, { ref: 'feature', stash: true })
    expect(value).toMatchObject({ committed: true, stashRestored: true })
    expect(repo.git('status', '--porcelain')).toBe(status)
    expect(stashCount(repo)).toBe(0)
  })

  it('keeps the stash (pending) when the merge stops on conflicts', async () => {
    const repo = makeRepo()
    diverged(repo, true)
    repo.write('README.md', '# unstaged\n')
    const failure = await failureOf(run(mergeOperation, repo, { ref: 'feature', stash: true }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', stashKept: true })
    expect(stashCount(repo)).toBe(1)
    expect(repo.gitResult('rev-parse', '-q', '--verify', PENDING_STASH_REF).status).toBe(0)
  })

  it('keeps the stash after a squash instead of popping it onto the staged result', async () => {
    const repo = makeRepo()
    diverged(repo)
    repo.write('README.md', '# unstaged\n')
    const value = await run(mergeOperation, repo, { ref: 'feature', squash: true, stash: true })
    expect(value).toMatchObject({ committed: false, stashKept: true })
    // The squash result stays staged exactly; the user's edit is safe in the stash.
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('feature.txt')
    expect(stashCount(repo)).toBe(1)
    expect(repo.git('stash', 'list')).toContain('dsh-git: before merge')
  })
})

describe('rebase', () => {
  it('replays the current branch onto the target', async () => {
    const repo = makeRepo()
    const { main } = diverged(repo)
    repo.git('checkout', '-q', 'feature')
    const value = await run(rebaseOperation, repo, { onto: 'main' })
    expect(value).toEqual({ head: sha(repo), committed: true })
    expect(sha(repo, 'HEAD~1')).toBe(main)
    expect(repo.git('symbolic-ref', '--short', 'HEAD').trim()).toBe('feature')
  })

  it('stops on conflicts in the rebase state', async () => {
    const repo = makeRepo()
    diverged(repo, true)
    repo.git('checkout', '-q', 'feature')
    const failure = await failureOf(run(rebaseOperation, repo, { onto: 'main' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'rebase', conflicts: 1 })
    expect(existsSync(join(repo.root, '.git', 'rebase-merge'))).toBe(true)
  })
})

describe('cherry-pick / revert', () => {
  it('cherry-picks a commit onto the current branch', async () => {
    const repo = makeRepo()
    const { feature } = diverged(repo)
    const value = await run(cherryPickOperation, repo, { sha: feature })
    expect(value.committed).toBe(true)
    expect(read(repo, 'feature.txt')).toBe('feature\n')
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('feature work')
  })

  it('stops a conflicting cherry-pick in the cherry-pick state', async () => {
    const repo = makeRepo()
    const { feature } = diverged(repo, true)
    const failure = await failureOf(run(cherryPickOperation, repo, { sha: feature }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'cherry-pick', conflicts: 1 })
  })

  it('reverts a commit without opening an editor', async () => {
    const repo = makeRepo()
    const { main } = diverged(repo)
    const value = await run(revertCommitOperation, repo, { sha: main })
    expect(value.committed).toBe(true)
    expect(existsSync(join(repo.root, 'main.txt'))).toBe(false)
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('Revert "main work"')
  })

  it('refuses merge commits (they need -m, P1) and unknown commits', async () => {
    const repo = makeRepo()
    diverged(repo)
    repo.git('merge', '-q', '--no-edit', 'feature')
    const merge = sha(repo)
    for (const op of [cherryPickOperation, revertCommitOperation]) {
      const failure = await failureOf(run(op as Op<unknown>, repo, { sha: merge }))
      expect(failure.code).toBe('git/invalid-payload')
      expect(failure.details).toMatchObject({ reason: 'merge-commit' })
      const unknown = await failureOf(run(op as Op<unknown>, repo, { sha: 'f'.repeat(40) }))
      expect(unknown.code).toBe('git/invalid-payload')
    }
    expect(sha(repo)).toBe(merge)
  })
})

describe('reset', () => {
  function threeCommits(repo: TempRepo): { base: string; head: string } {
    const base = sha(repo)
    repo.write('a.txt', 'a\n')
    repo.commit('a')
    repo.write('b.txt', 'b\n')
    const head = repo.commit('b')
    return { base, head }
  }

  it('soft keeps the changes staged, mixed unstaged, hard discards them', async () => {
    const repo = makeRepo()
    const { base, head } = threeCommits(repo)

    expect(await run(resetOperation, repo, { sha: base, mode: 'soft' })).toEqual({ head: base })
    expect(repo.git('diff', '--cached', '--name-only').trim().split('\n')).toEqual(['a.txt', 'b.txt'])

    repo.git('reset', '-q', '--hard', head)
    await run(resetOperation, repo, { sha: base, mode: 'mixed' })
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('')
    expect(repo.git('status', '--porcelain').trim().split('\n')).toEqual(['?? a.txt', '?? b.txt'])

    repo.git('add', '-A')
    repo.git('reset', '-q', '--hard', head)
    repo.write('a.txt', 'dirty\n')
    await run(resetOperation, repo, { sha: base, mode: 'hard', confirmHard: true })
    expect(sha(repo)).toBe(base)
    expect(existsSync(join(repo.root, 'a.txt'))).toBe(false)
  })

  it('refuses when HEAD moved since the preview (stale-target head)', async () => {
    const repo = makeRepo()
    const { base, head } = threeCommits(repo)
    repo.write('c.txt', 'c\n')
    repo.commit('c (the Agent committed meanwhile)')
    const failure = await failureOf(run(resetOperation, repo, { sha: base, mode: 'mixed', expectedHead: head }))
    expect(failure.code).toBe('git/stale-target')
    expect(failure.details).toEqual({ target: 'head', expected: head })
    expect(existsSync(join(repo.root, 'c.txt'))).toBe(true)
  })

  it('refuses an unknown target and an operation in progress', async () => {
    const repo = makeRepo()
    const unknown = await failureOf(run(resetOperation, repo, { sha: 'f'.repeat(40), mode: 'soft' }))
    expect(unknown.code).toBe('git/invalid-payload')

    diverged(repo, true)
    repo.gitResult('merge', '--no-edit', 'feature')
    const busy = await failureOf(run(resetOperation, repo, { sha: sha(repo), mode: 'soft' }))
    expect(busy.code).toBe('git/operation-in-progress')
  })

  it('previews the commits lost and the tracked changes a hard reset discards', async () => {
    const repo = makeRepo()
    const { base, head } = threeCommits(repo)
    repo.write('a.txt', 'dirty\n')
    repo.write('README.md', 'dirty\n')
    repo.write('untracked.txt', 'not counted\n')
    const preview = await readResetPreview(createGitRunner(createFakeSubprocess()), repo.root, base)
    expect(preview.head).toBe(head)
    expect(preview.discardCount).toBe(2)
    expect(preview.commitsLost.map((commit) => commit.subject)).toEqual(['b', 'a'])
    expect(preview.truncated).toBe(false)

    const none = await readResetPreview(createGitRunner(createFakeSubprocess()), repo.root, head)
    expect(none.commitsLost).toEqual([])
  })
})
