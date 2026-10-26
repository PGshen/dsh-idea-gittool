// A2 T3：Push Rejected 后的拉取（变基/合并，成功与冲突；本地 bare 远程）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { pullForPushOperation } from '../../src/host/git/pull.ts'
import { contextFor, createRemoteSetup, pushFromOther, scriptedContext } from './remote-fixtures.ts'
import type { RemoteSetup } from './remote-fixtures.ts'

// Each test spawns dozens of git processes (clones, pushes); allow for a loaded machine.
vi.setConfig({ testTimeout: 90_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setup(): RemoteSetup {
  const remote = createRemoteSetup()
  cleanups.push(remote.cleanup)
  return remote
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

async function pull(ctx: WriteContext, payload: Record<string, unknown>) {
  const op = pullForPushOperation
  return await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', remote: 'origin', branch: 'main', ...payload }))
}

/** Diverged history: their commit on the remote, mine locally, plus an uncommitted edit. */
function diverge(remote: RemoteSetup, conflicting: boolean): { theirs: string; mine: string } {
  remote.local.write('shared.txt', 'base\n')
  remote.local.commit('shared base')
  remote.local.git('push', '-q', 'origin', 'main')
  remote.other.git('pull', '-q', '--no-rebase', 'origin', 'main')
  const theirs = pushFromOther(remote.other, conflicting ? 'shared.txt' : 'theirs.txt', 'theirs\n', 'their change')
  remote.local.write(conflicting ? 'shared.txt' : 'mine.txt', 'mine\n')
  const mine = remote.local.commit('my change')
  return { theirs, mine }
}

describe('pullForPushOperation.parse', () => {
  it('requires a known mode and safe names', () => {
    const codeOf = (payload: unknown): string => {
      try {
        pullForPushOperation.parse(payload)
      } catch (error) {
        if (error instanceof GitCommandFailure) return error.code
        throw error
      }
      return 'ok'
    }
    expect(codeOf({ remote: 'origin', branch: 'main', mode: 'squash' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: '-o', branch: 'main', mode: 'rebase' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: 'origin', branch: 'main', mode: 'merge' })).toBe('ok')
  })
})

describe('pullForPushOperation.run', () => {
  it('rebases onto the remote branch and keeps uncommitted changes (autostash)', async () => {
    const remote = setup()
    const { theirs } = diverge(remote, false)
    remote.local.write('README.md', '# dirty worktree\n')

    const value = await pull(contextFor(remote.local), { mode: 'rebase' })

    expect(value.head).toBe(remote.local.git('rev-parse', 'HEAD').trim())
    expect(remote.local.git('rev-parse', 'HEAD~1').trim()).toBe(theirs)
    expect(remote.local.git('log', '-1', '--format=%s').trim()).toBe('my change')
    expect(readFileSync(join(remote.local.root, 'README.md'), 'utf8')).toBe('# dirty worktree\n')
  })

  it('merges the remote branch with a merge commit', async () => {
    const remote = setup()
    const { theirs, mine } = diverge(remote, false)

    const value = await pull(contextFor(remote.local), { mode: 'merge' })

    const parents = remote.local.git('log', '-1', '--format=%P', value.head).trim().split(' ')
    expect(parents).toEqual([mine, theirs])
  })

  it('stops a conflicting rebase in the rebase state with git/conflict', async () => {
    const remote = setup()
    diverge(remote, true)
    const failure = await failureOf(pull(contextFor(remote.local), { mode: 'rebase' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'rebase', mode: 'rebase' })
    expect(existsSync(join(remote.local.root, '.git', 'rebase-merge'))).toBe(true)
  })

  it('stops a conflicting merge in the merge state with git/conflict', async () => {
    const remote = setup()
    diverge(remote, true)
    const failure = await failureOf(pull(contextFor(remote.local), { mode: 'merge' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'merge', mode: 'merge' })
    expect(existsSync(join(remote.local.root, '.git', 'MERGE_HEAD'))).toBe(true)

    // While the merge is in progress another pull is refused.
    const again = await failureOf(pull(contextFor(remote.local), { mode: 'merge' }))
    expect(again.code).toBe('git/operation-in-progress')
  })

  it('rejects an unknown remote', async () => {
    const remote = setup()
    const failure = await failureOf(pull(contextFor(remote.local), { mode: 'rebase', remote: 'nope' }))
    expect(failure.code).toBe('git/invalid-payload')
  })

  it('maps a fetch auth failure to git/auth-required with a credential-free pull command', async () => {
    const { ctx, calls } = scriptedContext((args) => {
      if (args[0] === 'rev-parse') return { exitCode: 128 }
      if (args[0] === 'remote') return { stdout: 'origin\n' }
      if (args[0] === 'check-ref-format') return { exitCode: 0 }
      return {
        exitCode: 128,
        stderr: "fatal: could not read Password for 'https://carol:tok3n@example.com': terminal prompts disabled",
      }
    })
    const failure = await failureOf(pull(ctx, { mode: 'rebase' }))
    expect(failure.code).toBe('git/auth-required')
    expect(failure.details?.command).toBe('cd /work/repo && git pull --rebase origin main')
    expect(JSON.stringify(failure.details)).not.toContain('tok3n')
    expect(calls.some((args) => args[0] === 'rebase')).toBe(false)
  })
})

describe('pullForPushOperation / autostash conflict（评审 I2）', () => {
  it('reports git/conflict when restoring the autostash conflicts, instead of success', async () => {
    const remote = setup()
    remote.local.write('shared.txt', 'base\n')
    remote.local.commit('shared base')
    remote.local.git('push', '-q', 'origin', 'main')
    remote.other.git('pull', '-q', '--no-rebase', 'origin', 'main')
    pushFromOther(remote.other, 'shared.txt', 'theirs\n', 'their change')
    remote.local.write('mine.txt', 'mine\n')
    remote.local.commit('my change')
    // Uncommitted edit to the same file the remote changed.
    remote.local.write('shared.txt', 'local edit\n')

    const failure = await failureOf(pull(contextFor(remote.local), { mode: 'rebase' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ autostash: true })
    // The user's edit is still recoverable from the stash.
    expect(remote.local.git('stash', 'list').trim()).not.toBe('')
  })
})

describe('pullForPushOperation / keeps the staging area（演示问题 1）', () => {
  for (const mode of ['rebase', 'merge'] as const) {
    it(`restores staged vs unstaged exactly after a ${mode}`, async () => {
      const remote = setup()
      diverge(remote, false)
      // A staged change, an unstaged change, and a file with both (MM).
      remote.local.write('staged.txt', 'staged\n')
      remote.local.git('add', 'staged.txt')
      remote.local.write('README.md', '# unstaged\n')
      remote.local.write('mine.txt', 'mine staged\n')
      remote.local.git('add', 'mine.txt')
      remote.local.write('mine.txt', 'mine staged then edited\n')
      const before = remote.local.git('status', '--porcelain').split('\n').filter(Boolean).sort()

      await pull(contextFor(remote.local), { mode })

      const after = remote.local.git('status', '--porcelain').split('\n').filter(Boolean).sort()
      expect(after).toEqual(before)
      expect(remote.local.git('diff', '--cached', '--', 'mine.txt')).toContain('+mine staged')
      expect(remote.local.git('stash', 'list').trim()).toBe('')
    })
  }

  it('reports git/conflict and keeps the stash when a rebase stops on conflicts', async () => {
    const remote = setup()
    diverge(remote, true)
    remote.local.write('README.md', '# unstaged\n')
    const failure = await failureOf(pull(contextFor(remote.local), { mode: 'rebase' }))
    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ operation: 'rebase', stashed: true })
    expect(remote.local.git('stash', 'list').trim()).not.toBe('')
  })
})
