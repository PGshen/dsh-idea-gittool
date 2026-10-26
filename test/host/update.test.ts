// A3 T4：获取、拉取、更新项目、重置到远程（本地 bare 远程 + 脚本化分类）。
// 上游被强推时更新项目不合并，报 upstream-rewritten；重置到远程先建备份分支。
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WriteContext } from '../../src/host/git-executor.ts'
import { GitCommandFailure } from '../../src/host/git-executor.ts'
import { pullOperation } from '../../src/host/git/pull.ts'
import {
  backupBranchName,
  createResetToRemoteOperation,
  fetchOperation,
  parseFetchPorcelain,
  resetToRemoteOperation,
  updateProjectOperation,
} from '../../src/host/git/update.ts'
import { contextFor, createRemoteSetup, pushFromOther, scriptedContext } from './remote-fixtures.ts'
import type { RemoteSetup } from './remote-fixtures.ts'
import type { TempRepo } from './fixtures.ts'

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

interface Op<V> {
  parse(payload: unknown): unknown
  run(ctx: WriteContext, input: never): Promise<V>
}

async function runOn<V>(op: Op<V>, ctx: WriteContext, payload: Record<string, unknown>): Promise<V> {
  const input = op.parse({ sessionId: 's', requestId: 'r', ...payload })
  return await op.run(ctx, input as never)
}

const sha = (repo: TempRepo, rev = 'HEAD'): string => repo.git('rev-parse', rev).trim()

/** Someone rewrites origin/main: amend the tip and force-push it. */
function forcePushFromOther(remote: RemoteSetup): { oldSha: string; newSha: string } {
  const oldSha = sha(remote.other)
  remote.other.write('rewritten.txt', 'rewritten\n')
  remote.other.git('add', '-A')
  remote.other.git('commit', '-q', '--amend', '-m', 'rewritten history')
  remote.other.git('push', '-q', '--force', 'origin', 'HEAD:refs/heads/main')
  return { oldSha, newSha: sha(remote.other) }
}

describe('parseFetchPorcelain', () => {
  it('counts changed refs and ignores up-to-date and rejected lines', () => {
    const z = '0'.repeat(40)
    const a = 'a'.repeat(40)
    const stdout = [
      `* ${z} ${a} refs/remotes/origin/x`,
      `- ${a} ${z} refs/remotes/origin/gone`,
      `+ ${a} ${'b'.repeat(40)} refs/remotes/origin/forced`,
      `= ${a} ${a} refs/remotes/origin/main`,
      `! ${a} ${'c'.repeat(40)} refs/heads/main`,
      '',
    ].join('\n')
    expect(parseFetchPorcelain(stdout)).toBe(3)
  })
})

describe('fetch', () => {
  it('fetches new branches, prunes deleted ones and counts updated refs', async () => {
    const remote = setup()
    remote.other.git('push', '-q', 'origin', 'HEAD:refs/heads/x', 'HEAD:refs/heads/y')
    const first = await runOn(fetchOperation, contextFor(remote.local), { remote: 'origin', prune: false })
    expect(first).toEqual({ updatedRefs: 2 })
    expect(remote.local.git('branch', '-r')).toContain('origin/x')

    remote.other.git('push', '-q', 'origin', ':refs/heads/x')
    const pruned = await runOn(fetchOperation, contextFor(remote.local), { remote: 'origin', prune: true })
    expect(pruned).toEqual({ updatedRefs: 1 })
    expect(remote.local.git('branch', '-r')).not.toContain('origin/x')

    const all = await runOn(fetchOperation, contextFor(remote.local), { remote: null, prune: false })
    expect(all).toEqual({ updatedRefs: 0 })
  })

  it('validates the remote', async () => {
    const remote = setup()
    expect((await failureOf(runOn(fetchOperation, contextFor(remote.local), { remote: 'nope', prune: false }))).code).toBe(
      'git/invalid-payload',
    )
    expect(() => fetchOperation.parse({ remote: '--upload-pack=x', prune: false })).toThrow(GitCommandFailure)
    expect(() => fetchOperation.parse({ remote: 'origin' })).toThrow(GitCommandFailure)
  })

  it('falls back to a plain fetch when --porcelain is unknown (Git < 2.41)', async () => {
    const { ctx, calls } = scriptedContext((args) => {
      if (args[0] === 'remote') return { stdout: 'origin\n' }
      if (args[0] === 'fetch' && args.includes('--porcelain')) {
        return { exitCode: 129, stderr: "error: unknown option `porcelain'\nusage: git fetch [<options>]" }
      }
      return { exitCode: 0 }
    })
    const value = await runOn(fetchOperation, ctx, { remote: 'origin', prune: true })
    expect(value).toEqual({})
    const fetches = calls.filter((args) => args[0] === 'fetch')
    expect(fetches).toHaveLength(2)
    expect(fetches[1]).toEqual(['fetch', '--prune', '--no-recurse-submodules', '--', 'origin'])
  })

  it('maps a sandbox denial before auth and generic failures', async () => {
    const { ctx } = scriptedContext((args) => {
      if (args[0] === 'remote') return { stdout: 'origin\n' }
      return {
        exitCode: 128,
        stderr: "error: cannot open '.git/FETCH_HEAD': Operation not permitted\nfatal: could not read Username",
      }
    })
    expect((await failureOf(runOn(fetchOperation, ctx, { remote: null, prune: false }))).code).toBe('git/sandbox-denied')
  })

  it('maps an auth failure to git/auth-required with a credential-free command', async () => {
    const { ctx } = scriptedContext((args) => {
      if (args[0] === 'remote') return { stdout: 'origin\n' }
      return { exitCode: 128, stderr: "fatal: could not read Username for 'https://u:s3cret@x.test': terminal prompts disabled" }
    })
    const failure = await failureOf(runOn(fetchOperation, ctx, { remote: 'origin', prune: true }))
    expect(failure.code).toBe('git/auth-required')
    expect(failure.details?.command).toBe('cd /work/repo && git fetch --prune origin')
    expect(JSON.stringify(failure.details)).not.toContain('s3cret')
  })
})

describe('pull', () => {
  it('merges or rebases the remote branch; tracked changes need stash: true', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.write('mine.txt', 'mine\n')
    remote.local.commit('my change')
    remote.local.write('README.md', '# dirty\n')

    const dirty = await failureOf(
      runOn(pullOperation, contextFor(remote.local), { remote: 'origin', branch: 'main', mode: 'rebase' }),
    )
    expect(dirty.code).toBe('git/dirty-worktree')
    expect(dirty.details).toMatchObject({ operation: 'pull', count: 1 })
    expect(remote.local.git('rev-parse', '-q', '--verify', 'refs/remotes/origin/main').trim()).not.toBe(theirs)

    const value = await runOn(pullOperation, contextFor(remote.local), {
      remote: 'origin',
      branch: 'main',
      mode: 'rebase',
      stash: true,
    })
    expect(value).toMatchObject({ head: sha(remote.local), committed: true, stashRestored: true })
    expect(sha(remote.local, 'HEAD~1')).toBe(theirs)
    expect(readFileSync(join(remote.local.root, 'README.md'), 'utf8')).toBe('# dirty\n')
  })

  it('merge mode creates a merge commit', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.write('mine.txt', 'mine\n')
    const mine = remote.local.commit('my change')
    const value = await runOn(pullOperation, contextFor(remote.local), { remote: 'origin', branch: 'main', mode: 'merge' })
    expect(remote.local.git('log', '-1', '--format=%P', value.head).trim().split(' ')).toEqual([mine, theirs])
  })
})

describe('updateProject', () => {
  it('requires an upstream', async () => {
    const remote = setup()
    remote.local.git('checkout', '-q', '-b', 'topic')
    const failure = await failureOf(runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge' }))
    expect(failure.code).toBe('git/invalid-payload')
    expect(failure.details).toMatchObject({ reason: 'no-upstream' })
  })

  it('fetches the upstream and rebases onto it', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.write('mine.txt', 'mine\n')
    remote.local.commit('my change')
    const value = await runOn(updateProjectOperation, contextFor(remote.local), { mode: 'rebase' })
    expect(value).toMatchObject({ head: sha(remote.local), committed: true })
    expect(sha(remote.local, 'HEAD~1')).toBe(theirs)
  })

  it('refuses tracked changes before any network access unless stash: true', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.write('README.md', '# dirty\n')
    const failure = await failureOf(runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge' }))
    expect(failure.code).toBe('git/dirty-worktree')
    expect(failure.details).toMatchObject({ operation: 'update' })
    expect(sha(remote.local, 'origin/main')).not.toBe(theirs)

    const value = await runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge', stash: true })
    expect(value).toMatchObject({ head: theirs, stashRestored: true })
    expect(readFileSync(join(remote.local.root, 'README.md'), 'utf8')).toBe('# dirty\n')
  })

  it('reports a rewritten upstream instead of merging it, then resetToRemote backs up and resets', async () => {
    const remote = setup()
    remote.local.write('mine.txt', 'mine\n')
    const mine = remote.local.commit('my local work')
    const { oldSha, newSha } = forcePushFromOther(remote)

    const failure = await failureOf(runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge' }))
    expect(failure.code).toBe('git/upstream-rewritten')
    expect(failure.details).toEqual({ oldSha, newSha, localAhead: 2 })
    expect(sha(remote.local)).toBe(mine)

    const value = await runOn(resetToRemoteOperation, contextFor(remote.local), {})
    expect(sha(remote.local)).toBe(newSha)
    expect(value.head).toBe(newSha)
    expect(value.backupBranch).toMatch(/^backup\/main-\d{8}-\d{6}$/)
    expect(sha(remote.local, `refs/heads/${String(value.backupBranch)}`)).toBe(mine)
  })
})

describe('updateProject / rewritten upstream seen through the reflog (fix round 1)', () => {
  it('detects a rewrite that an earlier fetch already brought in', async () => {
    const remote = setup()
    remote.local.write('mine.txt', 'mine\n')
    const mine = remote.local.commit('my local work')
    const { oldSha, newSha } = forcePushFromOther(remote)
    await runOn(fetchOperation, contextFor(remote.local), { remote: 'origin', prune: false })
    expect(sha(remote.local, 'origin/main')).toBe(newSha)

    const failure = await failureOf(runOn(updateProjectOperation, contextFor(remote.local), { mode: 'rebase' }))
    expect(failure.code).toBe('git/upstream-rewritten')
    expect(failure.details).toEqual({ oldSha, newSha, localAhead: 2 })
    expect(sha(remote.local)).toBe(mine)
  })

  it('keeps reporting the rewrite on a second Update click', async () => {
    const remote = setup()
    remote.local.write('mine.txt', 'mine\n')
    const mine = remote.local.commit('my local work')
    const { oldSha, newSha } = forcePushFromOther(remote)
    for (let click = 0; click < 2; click += 1) {
      const failure = await failureOf(runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge' }))
      expect(failure.code).toBe('git/upstream-rewritten')
      expect(failure.details).toMatchObject({ oldSha, newSha })
    }
    expect(sha(remote.local)).toBe(mine)
  })

  it('integrates a normally advanced upstream after an earlier fetch (no false positive)', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.write('mine.txt', 'mine\n')
    remote.local.commit('my change')
    await runOn(fetchOperation, contextFor(remote.local), { remote: 'origin', prune: false })
    const value = await runOn(updateProjectOperation, contextFor(remote.local), { mode: 'rebase' })
    expect(value.committed).toBe(true)
    expect(sha(remote.local, 'HEAD~1')).toBe(theirs)
  })

  it('falls back to the before/after compare when the tracking ref has no reflog', async () => {
    const remote = setup()
    remote.local.git('config', 'core.logAllRefUpdates', 'false')
    remote.local.git('reflog', 'delete', '--rewrite', 'refs/remotes/origin/main@{0}')
    rmSync(join(remote.local.root, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), { force: true })
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    await runOn(fetchOperation, contextFor(remote.local), { remote: 'origin', prune: false })
    const value = await runOn(updateProjectOperation, contextFor(remote.local), { mode: 'merge' })
    expect(value.head).toBe(theirs)
  })
})

describe('resetToRemote', () => {
  it('formats the backup name in local time', () => {
    expect(backupBranchName('feature/x', new Date(2026, 9, 26, 7, 5, 9))).toBe('backup/feature/x-20261026-070509')
  })

  it('appends -2, -3 when the backup name is taken', async () => {
    const remote = setup()
    const now = new Date(2026, 9, 26, 7, 5, 9)
    remote.local.git('branch', 'backup/main-20261026-070509')
    remote.local.git('branch', 'backup/main-20261026-070509-2')
    const op = createResetToRemoteOperation(() => now)
    const value = await runOn(op, contextFor(remote.local), { backup: true })
    expect(value.backupBranch).toBe('backup/main-20261026-070509-3')
  })

  it('refuses before backing up when untracked or ignored files would be overwritten', async () => {
    const remote = setup()
    remote.local.write('.gitignore', '*.log\n')
    remote.local.commit('ignore logs')
    remote.local.git('push', '-q', 'origin', 'main')
    remote.other.git('pull', '-q', '--no-rebase', 'origin', 'main')
    remote.other.write('new.txt', 'theirs\n')
    remote.other.write('ignored.log', 'theirs\n')
    remote.other.git('add', '-f', 'new.txt', 'ignored.log')
    remote.other.git('commit', '-q', '-m', 'add files')
    remote.other.git('push', '-q', 'origin', 'HEAD:refs/heads/main')
    remote.local.git('fetch', '-q', 'origin')
    remote.local.write('new.txt', 'my untracked\n')
    remote.local.write('ignored.log', 'my ignored\n')
    const before = sha(remote.local)

    const failure = await failureOf(runOn(resetToRemoteOperation, contextFor(remote.local), {}))
    expect(failure.code).toBe('git/dirty-worktree')
    expect(failure.details).toEqual({ paths: ['ignored.log', 'new.txt'], count: 2 })
    expect(sha(remote.local)).toBe(before)
    expect(remote.local.git('branch', '--list', 'backup/*').trim()).toBe('')
    expect(readFileSync(join(remote.local.root, 'new.txt'), 'utf8')).toBe('my untracked\n')
  })

  it('refuses tracked changes without offering a stash, and can skip the backup', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'their change')
    remote.local.git('fetch', '-q', 'origin')
    remote.local.write('README.md', '# dirty\n')
    const failure = await failureOf(runOn(resetToRemoteOperation, contextFor(remote.local), {}))
    expect(failure.code).toBe('git/dirty-worktree')
    expect(failure.details).toEqual({ paths: ['README.md'], count: 1 })

    remote.local.git('checkout', '--', 'README.md')
    const value = await runOn(resetToRemoteOperation, contextFor(remote.local), { backup: false })
    expect(value).toEqual({ head: theirs })
    expect(remote.local.git('branch', '--list', 'backup/*').trim()).toBe('')
  })
})
