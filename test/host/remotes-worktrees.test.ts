// B3d T1–T3: remotes, tag push/delete, remote branch delete, upstream, worktrees (real repositories).
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import {
  readRemoteList,
  remoteBranchDeleteOperation,
  remoteEditOperation,
  setUpstreamOperation,
} from '../../src/host/git/remote-write.ts'
import { tagDeleteOperation, tagPushOperation } from '../../src/host/git/tag-write.ts'
import { readWorktreeList, worktreeAddOperation, worktreePruneOperation, worktreeRemoveOperation } from '../../src/host/git/worktree.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor, createRemoteSetup } from './remote-fixtures.ts'
import type { RemoteSetup } from './remote-fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const run = createGitRunner(createFakeSubprocess())

function remoteSetup(): RemoteSetup {
  const setup = createRemoteSetup()
  cleanups.push(setup.cleanup)
  return setup
}

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(repo.cleanup)
  return repo
}

const write = async <I, V>(operation: { parse(payload: unknown): I; run(ctx: ReturnType<typeof contextFor>, input: I): Promise<V> }, repo: TempRepo, payload: Record<string, unknown>): Promise<V> =>
  await operation.run(contextFor(repo), operation.parse({ sessionId: 's', requestId: 'r', ...payload }))

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('tags', () => {
  it('pushes a tag and deletes it locally and on the remote', async () => {
    const { local, bare } = remoteSetup()
    local.git('tag', 'v1')
    expect(await write(tagPushOperation, local, { name: 'v1', remote: 'origin' })).toEqual({ name: 'v1', remote: 'origin' })
    expect(local.git('ls-remote', '--tags', 'origin').trim()).toContain('refs/tags/v1')
    expect(await write(tagDeleteOperation, local, { name: 'v1', remote: 'origin' })).toEqual({ name: 'v1', localDeleted: true, remoteDeleted: true })
    expect(local.git('tag', '-l').trim()).toBe('')
    expect(local.git('ls-remote', '--tags', 'origin').trim()).toBe('')
    void bare
  })

  it('deletes only locally when no remote is given, and refuses unknown tags', async () => {
    const { local } = remoteSetup()
    local.git('tag', 'v2')
    local.git('push', '-q', 'origin', 'refs/tags/v2')
    expect(await write(tagDeleteOperation, local, { name: 'v2' })).toEqual({ name: 'v2', localDeleted: true, remoteDeleted: false })
    expect(local.git('ls-remote', '--tags', 'origin').trim()).toContain('refs/tags/v2')
    expect((await failureOf(write(tagDeleteOperation, local, { name: 'nope' }))).code).toBe('git/stale-target')
    expect((await failureOf(write(tagPushOperation, local, { name: '-x', remote: 'origin' }))).code).toBe('git/invalid-payload')
  })

  it('keeps the local tag when deleting it on the remote fails, so the user can retry', async () => {
    const { local } = remoteSetup()
    local.git('tag', 'v3')
    local.git('remote', 'add', 'gone', 'https://alice:secret@127.0.0.1:9/none.git')
    const failure = await failureOf(write(tagDeleteOperation, local, { name: 'v3', remote: 'gone' }))
    expect(JSON.stringify(failure)).not.toContain('secret')
    expect(local.git('tag', '-l', 'v3').trim()).toBe('v3')
  })
})

describe('remote branches and upstream', () => {
  it('deletes a remote branch and its tracking ref', async () => {
    const { local } = remoteSetup()
    local.git('push', '-q', 'origin', 'HEAD:refs/heads/topic')
    local.git('fetch', '-q', 'origin')
    expect(await write(remoteBranchDeleteOperation, local, { remote: 'origin', branch: 'topic' })).toEqual({ remote: 'origin', branch: 'topic' })
    expect(local.git('ls-remote', '--heads', 'origin').trim()).not.toContain('topic')
    expect(local.gitResult('rev-parse', '--verify', '-q', 'refs/remotes/origin/topic').status).not.toBe(0)
    expect((await failureOf(write(remoteBranchDeleteOperation, local, { remote: 'origin', branch: 'topic' }))).code).toBe('git/stale-target')
  })

  it('sets and unsets the upstream of a local branch', async () => {
    const { local } = remoteSetup()
    local.git('push', '-q', 'origin', 'HEAD:refs/heads/other')
    local.git('fetch', '-q', 'origin')
    local.git('branch', 'feature')
    expect(await write(setUpstreamOperation, local, { branch: 'feature', upstream: 'origin/other' })).toEqual({ branch: 'feature', upstream: 'origin/other' })
    expect(local.git('rev-parse', '--abbrev-ref', 'feature@{upstream}').trim()).toBe('origin/other')
    expect(await write(setUpstreamOperation, local, { branch: 'feature', upstream: null })).toEqual({ branch: 'feature', upstream: null })
    expect(local.gitResult('rev-parse', '--abbrev-ref', 'feature@{upstream}').status).not.toBe(0)
    expect((await failureOf(write(setUpstreamOperation, local, { branch: 'feature', upstream: 'origin/missing' }))).code).toBe('git/invalid-payload')
  })
})

describe('remotes', () => {
  it('lists remotes with credentials redacted and edits them', async () => {
    const repo = makeRepo()
    await write(remoteEditOperation, repo, { action: 'add', name: 'up', url: 'https://alice:secret@example.com/r.git' })
    let remotes = await readRemoteList(run, repo.root)
    expect(remotes).toEqual([{ name: 'up', fetchUrl: 'https://***@example.com/r.git', pushUrl: 'https://***@example.com/r.git' }])
    expect(JSON.stringify(remotes)).not.toContain('secret')
    await write(remoteEditOperation, repo, { action: 'setUrl', name: 'up', url: 'https://example.com/other.git' })
    await write(remoteEditOperation, repo, { action: 'rename', name: 'up', newName: 'upstream' })
    remotes = await readRemoteList(run, repo.root)
    expect(remotes.map(remote => [remote.name, remote.fetchUrl])).toEqual([['upstream', 'https://example.com/other.git']])
    await write(remoteEditOperation, repo, { action: 'remove', name: 'upstream' })
    expect(await readRemoteList(run, repo.root)).toEqual([])
    expect((await failureOf(write(remoteEditOperation, repo, { action: 'add', name: 'x', url: '--upload-pack=evil' }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(remoteEditOperation, repo, { action: 'add', name: '-x', url: 'https://e/x' }))).code).toBe('git/invalid-payload')
  })
})

describe('worktrees', () => {
  it('lists, adds from an existing or a new branch, removes and prunes', async () => {
    const repo = makeRepo()
    repo.git('branch', 'side')
    const list = await readWorktreeList(run, repo.root)
    expect(list).toEqual([expect.objectContaining({ path: repo.root, branch: 'main', current: true, locked: false, prunable: false })])
    const added = await write(worktreeAddOperation, repo, { path: '.worktrees/side', branch: 'side' })
    expect(added.worktree).toMatchObject({ path: realpathSync(join(repo.root, '.worktrees/side')), branch: 'side', current: false })
    // The new worktree must not show up as an untracked (embedded repository) path in the main worktree.
    expect(repo.git('status', '--porcelain', '--untracked-files=all').trim()).toBe('')
    expect(readFileSync(join(repo.root, '.git/info/exclude'), 'utf8')).toContain('/.worktrees/side/')
    await write(worktreeAddOperation, repo, { path: '.worktrees/fresh', branch: 'fresh', createBranch: true })
    expect(repo.git('rev-parse', 'fresh').trim()).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect((await readWorktreeList(run, repo.root)).map(entry => entry.branch).sort()).toEqual(['fresh', 'main', 'side'])
    expect((await failureOf(write(worktreeAddOperation, repo, { path: '.worktrees/again', branch: 'side' }))).code).toBe('git/invalid-payload')
    repo.write('.worktrees/side/dirty.txt', 'x\n')
    expect((await failureOf(write(worktreeRemoveOperation, repo, { path: added.worktree.path }))).details).toMatchObject({ reason: 'worktree-dirty' })
    await write(worktreeRemoveOperation, repo, { path: added.worktree.path, force: true })
    expect(existsSync(join(repo.root, '.worktrees/side'))).toBe(false)
    // A worktree whose directory was deleted by hand becomes prunable.
    rmSync(realpathSync(join(repo.root, '.worktrees/fresh')), { recursive: true, force: true })
    expect((await readWorktreeList(run, repo.root)).find(entry => entry.branch === 'fresh')?.prunable).toBe(true)
    expect(await write(worktreePruneOperation, repo, {})).toEqual({ pruned: 1 })
    expect((await failureOf(write(worktreeRemoveOperation, repo, { path: repo.root }))).details).toMatchObject({ reason: 'current-worktree' })
  })

  it('refuses paths outside the repository and option-like branches', async () => {
    const repo = makeRepo()
    expect((await failureOf(write(worktreeAddOperation, repo, { path: '../outside', branch: 'x', createBranch: true }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(worktreeAddOperation, repo, { path: '/tmp/abs', branch: 'x', createBranch: true }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(worktreeAddOperation, repo, { path: '.worktrees/x', branch: '-b', createBranch: true }))).code).toBe('git/invalid-payload')
  })
})
