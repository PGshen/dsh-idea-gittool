// A3 T3：分支写操作（真实临时仓库）。签出四种目标、智能签出（仅 git 拒绝时才问）、
// 新建/重命名/删除；用户输入不能被当成选项，目标在执行时重新核对。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import {
  checkoutOperation,
  createBranchOperation,
  deleteBranchOperation,
  renameBranchOperation,
  wouldOverwriteDetails,
} from '../../src/host/git/branch-write.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor, createRemoteSetup } from './remote-fixtures.ts'
import type { RemoteSetup } from './remote-fixtures.ts'

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

function makeRemote(): RemoteSetup {
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

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  return 'ok'
}

const BASE = { sessionId: 's', requestId: 'r' }

async function checkout(ctx: WriteContext, kind: string, name: string, mode?: string) {
  const op = checkoutOperation
  return await op.run(ctx, op.parse({ ...BASE, target: { kind, name }, ...(mode === undefined ? {} : { mode }) }))
}

async function createBranch(ctx: WriteContext, name: string, startPoint: string, checkoutAfter: boolean) {
  const op = createBranchOperation
  return await op.run(ctx, op.parse({ ...BASE, name, startPoint, checkout: checkoutAfter }))
}

async function renameBranch(ctx: WriteContext, from: string, to: string) {
  const op = renameBranchOperation
  return await op.run(ctx, op.parse({ ...BASE, from, to }))
}

async function deleteBranch(ctx: WriteContext, name: string, force: boolean, expectedSha?: string) {
  const op = deleteBranchOperation
  return await op.run(ctx, op.parse({ ...BASE, name, force, ...(expectedSha === undefined ? {} : { expectedSha }) }))
}

function sha(repo: TempRepo, rev: string): string {
  return repo.git('rev-parse', rev).trim()
}

function currentBranch(repo: TempRepo): string {
  return repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()
}

function read(repo: TempRepo, path: string): string {
  return readFileSync(join(repo.root, path), 'utf8')
}

function stashCount(repo: TempRepo): number {
  return repo.git('stash', 'list').split('\n').filter(Boolean).length
}

/** `feature` rewrites line 1 of notes.txt (5 lines) and the Unicode file; leaves main checked out. */
function featureBranch(repo: TempRepo): void {
  repo.write('notes.txt', 'one\ntwo\nthree\nfour\nfive\n')
  repo.write('说明 文件.txt', 'base\n')
  repo.commit('notes')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('notes.txt', 'ONE (feature)\ntwo\nthree\nfour\nfive\n')
  repo.write('说明 文件.txt', 'feature\n')
  repo.commit('feature edits')
  repo.git('checkout', '-q', 'main')
}

describe('wouldOverwriteDetails (stderr samples, git 2.50)', () => {
  it('separates tracked local changes from untracked files in the way', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by checkout:',
      '\tnotes.txt',
      '\t说明 文件.txt',
      'Please commit your changes or stash them before you switch branches.',
      'error: The following untracked working tree files would be overwritten by checkout:',
      '\tnew file.txt',
      'Please move or remove them before you switch branches.',
      'Aborting',
    ].join('\n')
    expect(wouldOverwriteDetails(stderr)).toEqual({
      paths: ['notes.txt', '说明 文件.txt'],
      untracked: ['new file.txt'],
    })
  })

  it('reads the untracked-only, removed-by-checkout and lost-directory variants into untracked', () => {
    expect(
      wouldOverwriteDetails(
        'error: The following untracked working tree files would be overwritten by checkout:\n\tnewfile\nPlease move or remove them before you switch branches.\nAborting\n',
      ),
    ).toEqual({ paths: [], untracked: ['newfile'] })
    expect(
      wouldOverwriteDetails(
        'error: The following untracked working tree files would be removed by checkout:\n\tgone.txt\nPlease move or remove them before you switch branches.\nAborting\n',
      ),
    ).toEqual({ paths: [], untracked: ['gone.txt'] })
    expect(
      wouldOverwriteDetails('error: Updating the following directories would lose untracked files in them:\n\td\n\nAborting\n'),
    ).toEqual({ paths: [], untracked: ['d'] })
  })

  it('returns undefined for unrelated failures', () => {
    expect(wouldOverwriteDetails("fatal: invalid reference: nope\n")).toBeUndefined()
  })
})

describe('checkoutOperation.parse', () => {
  it('validates target kind, name and mode', () => {
    const parse = (payload: Record<string, unknown>) => () => checkoutOperation.parse({ ...BASE, ...payload })
    expect(codeOf(parse({ target: { kind: 'local', name: 'main' } }))).toBe('ok')
    expect(codeOf(parse({ target: { kind: 'branch', name: 'main' } }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ target: { kind: 'local', name: '--orphan' } }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ target: { kind: 'revision', name: 'HEAD~1 x' } }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ target: 'main' }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ target: { kind: 'local', name: 'main' }, mode: 'hard' }))).toBe('git/invalid-payload')
  })
})

describe('checkout', () => {
  it('switches to a local branch and carries unrelated local changes along', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('README.md', '# my edit\n')
    const value = await checkout(contextFor(repo), 'local', 'feature')
    expect(value).toEqual({ branch: 'feature', detached: false, head: sha(repo, 'feature') })
    expect(currentBranch(repo)).toBe('feature')
    expect(read(repo, 'README.md')).toBe('# my edit\n')
    expect(stashCount(repo)).toBe(0)
  })

  it('detaches at a tag and at a revision', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.git('tag', 'v1', 'feature')
    const ctx = contextFor(repo)
    expect(await checkout(ctx, 'tag', 'v1')).toEqual({ branch: null, detached: true, head: sha(repo, 'feature') })
    expect(await checkout(ctx, 'revision', 'main~1')).toEqual({
      branch: null,
      detached: true,
      head: sha(repo, 'main~1'),
    })
    expect(sha(repo, 'HEAD')).toBe(sha(repo, 'main~1'))
  })

  it('rejects an unknown revision and a vanished local branch without moving HEAD', async () => {
    const repo = makeRepo()
    const ctx = contextFor(repo)
    expect((await failureOf(checkout(ctx, 'revision', 'nope~3'))).code).toBe('git/invalid-payload')
    const stale = await failureOf(checkout(ctx, 'local', 'gone'))
    expect(stale.code).toBe('git/stale-target')
    expect(stale.details).toMatchObject({ target: 'branch', expected: 'gone' })
    expect(currentBranch(repo)).toBe('main')
  })

  it('refuses while an operation is in progress', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('a.txt', 'feature\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('a.txt', 'main\n')
    repo.commit('main')
    repo.gitResult('merge', 'feature')
    const failure = await failureOf(checkout(contextFor(repo), 'local', 'feature'))
    expect(failure.code).toBe('git/operation-in-progress')
  })

  it('reports would-overwrite with paths in normal mode and leaves everything as it was', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('notes.txt', 'one\ntwo\nthree\nfour\nFIVE (mine)\n')
    repo.write('说明 文件.txt', 'mine\n')
    const before = repo.git('status', '--porcelain')
    const failure = await failureOf(checkout(contextFor(repo), 'local', 'feature'))
    expect(failure.code).toBe('git/would-overwrite')
    expect((failure.details?.paths as string[]).sort()).toEqual(['notes.txt', '说明 文件.txt'].sort())
    expect(currentBranch(repo)).toBe('main')
    expect(repo.git('status', '--porcelain')).toBe(before)
    expect(read(repo, 'notes.txt')).toBe('one\ntwo\nthree\nfour\nFIVE (mine)\n')
    expect(stashCount(repo)).toBe(0)
  })

  it('stash mode stashes, switches and restores the changes (staged state kept)', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('notes.txt', 'one\ntwo\nthree\nfour\nFIVE (mine)\n')
    repo.git('add', 'notes.txt')
    const value = await checkout(contextFor(repo), 'local', 'feature', 'stash')
    expect(value).toMatchObject({ branch: 'feature', detached: false, stashRestored: true })
    expect(read(repo, 'notes.txt')).toBe('ONE (feature)\ntwo\nthree\nfour\nFIVE (mine)\n')
    expect(repo.git('status', '--porcelain', '--', 'notes.txt')).toBe('M  notes.txt\n')
    expect(stashCount(repo)).toBe(0)
  })

  it('stash mode keeps the stash when restoring conflicts but still reports the checkout', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('说明 文件.txt', 'mine\n')
    const value = await checkout(contextFor(repo), 'local', 'feature', 'stash')
    expect(value).toMatchObject({ branch: 'feature', stashKept: true })
    expect(currentBranch(repo)).toBe('feature')
    expect(stashCount(repo)).toBe(1)
  })

  it('reports untracked files in the way separately (stash cannot help with them)', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.git('checkout', '-q', 'feature')
    repo.write('only-on-feature.txt', 'feature\n')
    repo.commit('add file on feature')
    repo.git('checkout', '-q', 'main')
    repo.write('only-on-feature.txt', 'my untracked\n')
    const failure = await failureOf(checkout(contextFor(repo), 'local', 'feature'))
    expect(failure.code).toBe('git/would-overwrite')
    expect(failure.details).toEqual({ paths: [], untracked: ['only-on-feature.txt'] })
    expect(read(repo, 'only-on-feature.txt')).toBe('my untracked\n')
  })

  it('force mode also discards unrelated tracked edits (switch --discard-changes)', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('README.md', '# unrelated edit\n')
    repo.write('notes.txt', 'mine\n')
    await checkout(contextFor(repo), 'local', 'feature', 'force')
    expect(read(repo, 'README.md')).toBe('# fixture\n')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('force mode discards the changes that would be overwritten', async () => {
    const repo = makeRepo()
    featureBranch(repo)
    repo.write('notes.txt', 'mine\n')
    const value = await checkout(contextFor(repo), 'local', 'feature', 'force')
    expect(value).toMatchObject({ branch: 'feature', detached: false })
    expect(read(repo, 'notes.txt')).toBe('ONE (feature)\ntwo\nthree\nfour\nfive\n')
    expect(stashCount(repo)).toBe(0)
  })
})

describe('checkout of a remote branch', () => {
  function remoteFeature(remote: RemoteSetup): string {
    remote.other.git('checkout', '-q', '-b', 'feat')
    remote.other.write('feat.txt', 'remote feat\n')
    const tip = remote.other.commit('remote feat')
    remote.other.git('push', '-q', 'origin', 'feat')
    remote.local.git('fetch', '-q', 'origin')
    return tip
  }

  it('creates a tracking local branch when none exists', async () => {
    const remote = makeRemote()
    const tip = remoteFeature(remote)
    const value = await checkout(contextFor(remote.local), 'remote', 'origin/feat')
    expect(value).toEqual({ branch: 'feat', detached: false, head: tip })
    expect(remote.local.git('rev-parse', '--abbrev-ref', 'feat@{upstream}').trim()).toBe('origin/feat')
  })

  it('switches to the existing local branch of the same name', async () => {
    const remote = makeRemote()
    remoteFeature(remote)
    remote.local.git('branch', 'feat', 'main')
    const localTip = sha(remote.local, 'feat')
    const value = await checkout(contextFor(remote.local), 'remote', 'origin/feat')
    expect(value).toEqual({ branch: 'feat', detached: false, head: localTip })
  })

  it('rejects a name that is not under a configured remote', async () => {
    const remote = makeRemote()
    const failure = await failureOf(checkout(contextFor(remote.local), 'remote', 'upstream/feat'))
    expect(failure.code).toBe('git/invalid-payload')
  })
})

describe('createBranch', () => {
  it('creates without checking out, and with checkout', async () => {
    const repo = makeRepo()
    const first = sha(repo, 'HEAD')
    repo.write('a.txt', 'a\n')
    repo.commit('second')
    const ctx = contextFor(repo)
    expect(await createBranch(ctx, 'from-first', first, false)).toEqual({
      branch: 'from-first',
      sha: first,
      checkedOut: false,
    })
    expect(currentBranch(repo)).toBe('main')
    expect(await createBranch(ctx, '功能/新', 'main', true)).toEqual({
      branch: '功能/新',
      sha: sha(repo, 'main'),
      checkedOut: true,
    })
    expect(currentBranch(repo)).toBe('功能/新')
  })

  it('tracks the remote branch when starting from origin/x, not from a local branch or sha', async () => {
    const remote = makeRemote()
    remote.other.git('checkout', '-q', '-b', 'feat')
    remote.other.write('feat.txt', 'feat\n')
    const tip = remote.other.commit('feat')
    remote.other.git('push', '-q', 'origin', 'feat')
    remote.local.git('fetch', '-q', 'origin')
    const ctx = contextFor(remote.local)
    const upstreamOf = (branch: string) => remote.local.gitResult('rev-parse', '--abbrev-ref', `${branch}@{upstream}`)

    expect(await createBranch(ctx, 'mine', 'origin/feat', false)).toEqual({ branch: 'mine', sha: tip, checkedOut: false })
    expect(upstreamOf('mine').stdout.trim()).toBe('origin/feat')
    expect(await createBranch(ctx, 'mine-co', 'origin/feat', true)).toMatchObject({ sha: tip, checkedOut: true })
    expect(upstreamOf('mine-co').stdout.trim()).toBe('origin/feat')

    await createBranch(ctx, 'from-local', 'main', false)
    expect(upstreamOf('from-local').status).not.toBe(0)
    await createBranch(ctx, 'from-sha', tip, true)
    expect(upstreamOf('from-sha').status).not.toBe(0)
  })

  it('rejects invalid names, existing branches and unknown start points', async () => {
    const repo = makeRepo()
    const ctx = contextFor(repo)
    expect((await failureOf(createBranch(ctx, 'bad..name', 'main', false))).code).toBe('git/invalid-payload')
    expect((await failureOf(createBranch(ctx, '@{-1}', 'main', false))).code).toBe('git/invalid-payload')
    expect(codeOf(() => createBranchOperation.parse({ ...BASE, name: '-x', startPoint: 'main', checkout: false }))).toBe(
      'git/invalid-payload',
    )
    const exists = await failureOf(createBranch(ctx, 'main', 'HEAD', false))
    expect(exists.code).toBe('git/branch-exists')
    expect(exists.details).toMatchObject({ branch: 'main' })
    expect((await failureOf(createBranch(ctx, 'x', 'no-such-ref', false))).code).toBe('git/invalid-payload')
  })
})

describe('renameBranch', () => {
  it('renames a local branch; existing target → branch-exists', async () => {
    const repo = makeRepo()
    repo.git('branch', 'old')
    repo.git('branch', 'taken')
    const ctx = contextFor(repo)
    const exists = await failureOf(renameBranch(ctx, 'old', 'taken'))
    expect(exists.code).toBe('git/branch-exists')
    expect(exists.details).toMatchObject({ branch: 'taken' })
    expect(await renameBranch(ctx, 'old', '新名字')).toEqual({ branch: '新名字' })
    expect(repo.gitResult('rev-parse', '--verify', 'refs/heads/old').status).not.toBe(0)
    expect(repo.gitResult('rev-parse', '--verify', 'refs/heads/新名字').status).toBe(0)
    expect((await failureOf(renameBranch(ctx, 'gone', 'other'))).code).toBe('git/stale-target')
    expect((await failureOf(renameBranch(ctx, 'taken', 'a..b'))).code).toBe('git/invalid-payload')
  })
})

describe('deleteBranch', () => {
  it('refuses the current branch', async () => {
    const repo = makeRepo()
    const failure = await failureOf(deleteBranch(contextFor(repo), 'main', true))
    expect(failure.code).toBe('git/invalid-payload')
    expect(repo.gitResult('rev-parse', '--verify', 'refs/heads/main').status).toBe(0)
  })

  it('reports not-merged, then force-deletes', async () => {
    const repo = makeRepo()
    repo.git('checkout', '-q', '-b', 'topic')
    repo.write('t.txt', 't\n')
    const tip = repo.commit('topic work')
    repo.git('checkout', '-q', 'main')
    const ctx = contextFor(repo)
    const failure = await failureOf(deleteBranch(ctx, 'topic', false))
    expect(failure.code).toBe('git/not-merged')
    expect(failure.details).toMatchObject({ branch: 'topic' })
    expect(sha(repo, 'refs/heads/topic')).toBe(tip)
    expect(await deleteBranch(ctx, 'topic', true, tip)).toEqual({ branch: 'topic', sha: tip })
    expect(repo.gitResult('rev-parse', '--verify', 'refs/heads/topic').status).not.toBe(0)
  })

  it('deletes a merged branch with -d', async () => {
    const repo = makeRepo()
    repo.git('branch', 'merged')
    const tip = sha(repo, 'merged')
    expect(await deleteBranch(contextFor(repo), 'merged', false)).toEqual({ branch: 'merged', sha: tip })
  })

  it('refuses when the branch tip moved since the client saw it (stale-target)', async () => {
    const repo = makeRepo()
    repo.git('branch', 'topic')
    const seen = sha(repo, 'topic')
    repo.git('checkout', '-q', 'topic')
    repo.write('t.txt', 'new\n')
    repo.commit('moved')
    repo.git('checkout', '-q', 'main')
    const failure = await failureOf(deleteBranch(contextFor(repo), 'topic', true, seen))
    expect(failure.code).toBe('git/stale-target')
    expect(failure.details).toMatchObject({ target: 'branch', expected: seen })
    expect(repo.gitResult('rev-parse', '--verify', 'refs/heads/topic').status).toBe(0)
    expect((await failureOf(deleteBranch(contextFor(repo), 'gone', true))).code).toBe('git/stale-target')
  })

  it('validates force and expectedSha in parse', () => {
    const parse = (payload: Record<string, unknown>) => () => deleteBranchOperation.parse({ ...BASE, ...payload })
    expect(codeOf(parse({ name: 'x', force: 'yes' }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ name: 'x', force: false, expectedSha: 'abc' }))).toBe('git/invalid-payload')
    expect(codeOf(parse({ name: '-D', force: false }))).toBe('git/invalid-payload')
  })
})
