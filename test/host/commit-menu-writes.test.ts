// B3b T3: Host endpoints of the commit menu — tags, push up to a commit, patches, fixup/squash into.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { fixupCommitOperation } from '../../src/host/git/fixup.ts'
import { applyPatchOperation, readFormatPatch } from '../../src/host/git/patch.ts'
import { pushOperation, readPushPreview } from '../../src/host/git/push.ts'
import { createTagOperation } from '../../src/host/git/tag-write.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo, writeExecutableScript } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor, createRemoteSetup } from './remote-fixtures.ts'

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

/** A commit on a new branch from `start` that no other fixture commit can coincide with. */
function sideCommit(repo: TempRepo, start: string): string {
  repo.git('checkout', '-q', '-b', 'side', start)
  repo.write('side-only.txt', 'side\n')
  const sha = repo.commit('side commit')
  repo.git('checkout', '-q', 'main')
  return sha
}

function linear(repo: TempRepo, count: number): string[] {
  const shas: string[] = []
  for (let index = 1; index <= count; index += 1) {
    repo.write(`f${String(index)}.txt`, `${String(index)}\n`)
    shas.push(repo.commit(`c${String(index)}`))
  }
  return shas
}

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

/** Parse + run as the RPC layer does; a parse failure becomes a rejection like any other. */
const write = async <I, V>(operation: { parse(payload: unknown): I; run(ctx: ReturnType<typeof contextFor>, input: I): Promise<V> }, repo: TempRepo, payload: Record<string, unknown>): Promise<V> =>
  await operation.run(contextFor(repo), operation.parse({ sessionId: 's', requestId: 'r', ...payload }))

describe('createTag', () => {
  it('creates a lightweight tag, or an annotated one with a message', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    expect(await write(createTagOperation, repo, { name: 'v1', target: c1 })).toEqual({ name: 'v1', target: c1 })
    expect(repo.git('cat-file', '-t', 'v1').trim()).toBe('commit')
    await write(createTagOperation, repo, { name: 'rel/2', target: c2, message: 'Release "two"\n\n$(nope)' })
    expect(repo.git('cat-file', '-t', 'rel/2').trim()).toBe('tag')
    expect(repo.git('rev-parse', 'rel/2^{commit}').trim()).toBe(c2)
    expect(repo.git('tag', '-l', '--format=%(contents)', 'rel/2').trim()).toBe('Release "two"\n\n$(nope)')
  })

  it('refuses an existing name, an invalid name and an option-like name', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 1)
    await write(createTagOperation, repo, { name: 'v1', target: c1 })
    expect(await failureOf(write(createTagOperation, repo, { name: 'v1', target: c1 }))).toMatchObject({ code: 'git/branch-exists', details: { kind: 'tag', branch: 'v1' } })
    expect((await failureOf(write(createTagOperation, repo, { name: 'bad..name', target: c1 }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(createTagOperation, repo, { name: '-d', target: c1 }))).code).toBe('git/invalid-payload')
  })
})

describe('push up to a commit', () => {
  it('previews and pushes only up to the revision', async () => {
    const setup = createRemoteSetup()
    cleanups.push(setup.cleanup)
    const repo = setup.local
    const [c1, c2] = linear(repo, 3)
    const preview = await readPushPreview(run, repo.root, { revision: c2 })
    expect(preview.commits.map(commit => commit.sha)).toEqual([c2, c1])
    await write(pushOperation, repo, { remote: 'origin', branch: 'main', revision: c2 })
    expect(repo.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(c2)
  })

  it('refuses a revision that is not an ancestor of HEAD', async () => {
    const setup = createRemoteSetup()
    cleanups.push(setup.cleanup)
    const repo = setup.local
    linear(repo, 1)
    const side = sideCommit(repo, 'HEAD~1')
    expect((await failureOf(write(pushOperation, repo, { remote: 'origin', branch: 'main', revision: side }))).code).toBe('git/invalid-payload')
    expect((await failureOf(readPushPreview(run, repo.root, { revision: side }))).code).toBe('git/invalid-payload')
  })
})

describe('formatPatch and applyPatch', () => {
  it('exports commits like git format-patch --stdout, oldest first, and names the file', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    const single = await readFormatPatch(run, repo.root, [c2 ?? ''])
    expect(single.patch).toBe(repo.git('format-patch', '--stdout', '-1', c2 ?? ''))
    expect(single.fileName).toBe(`${(c2 ?? '').slice(0, 7)}-c2.patch`)
    const both = await readFormatPatch(run, repo.root, [c2 ?? '', c1 ?? ''])
    expect(both.patch.indexOf('Subject: [PATCH 1/2] c1')).toBeGreaterThan(-1)
    expect(both.patch.indexOf('Subject: [PATCH 1/2] c1')).toBeLessThan(both.patch.indexOf('Subject: [PATCH 2/2] c2'))
    expect(both.patch).not.toContain('Subject: [PATCH] ')
    expect(both.fileName).toBe('2-commits.patch')
  })

  it('refuses merge commits', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    sideCommit(repo, 'HEAD~1')
    repo.git('-c', 'user.name=T', '-c', 'user.email=t@x', 'merge', '-q', '--no-ff', '-m', 'merge', 'side')
    const failure = await failureOf(readFormatPatch(run, repo.root, [repo.git('rev-parse', 'HEAD').trim()]))
    expect(failure.details, failure.message).toMatchObject({ reason: 'merge-commit' })
  })

  it('previews and applies a mailbox with git am, keeping author and message', async () => {
    const source = makeRepo()
    const [c1, c2] = linear(source, 2)
    const { patch } = await readFormatPatch(run, source.root, [c1 ?? '', c2 ?? ''])
    const target = makeRepo()
    const preview = await write(applyPatchOperation, target, { patch, check: true })
    expect(preview).toEqual({ format: 'mbox', files: ['f1.txt', 'f2.txt'], applied: false, commits: 2 })
    expect(existsSync(join(target.root, 'f1.txt'))).toBe(false)
    expect(await write(applyPatchOperation, target, { patch })).toMatchObject({ format: 'mbox', applied: true, commits: 2 })
    expect(target.git('log', '--format=%s', '-2').trim().split('\n')).toEqual(['c2', 'c1'])
  })

  it('applies a plain diff to the index, and leaves nothing behind when it does not apply', async () => {
    const source = makeRepo()
    source.write('README.md', '# changed\n')
    const patch = source.git('diff')
    const target = makeRepo()
    expect(await write(applyPatchOperation, target, { patch, check: true })).toEqual({ format: 'diff', files: ['README.md'], applied: false })
    expect(await write(applyPatchOperation, target, { patch })).toMatchObject({ format: 'diff', applied: true })
    expect(target.git('diff', '--cached', '--name-only').trim()).toBe('README.md')
    const failure = await failureOf(write(applyPatchOperation, target, { patch }))
    expect(failure.code).toBe('git/exec-failed')
    expect(String(failure.details?.output ?? '')).toMatch(/patch does not apply|already exists/u)
  })

  it('aborts a mailbox that fails half-way', async () => {
    const source = makeRepo()
    const [c1, c2] = linear(source, 2)
    const { patch } = await readFormatPatch(run, source.root, [c1 ?? '', c2 ?? ''])
    const target = makeRepo()
    target.write('f2.txt', 'conflicting\n')
    target.commit('conflict')
    const before = target.git('rev-parse', 'HEAD').trim()
    await failureOf(write(applyPatchOperation, target, { patch }))
    expect(target.git('rev-parse', 'HEAD').trim()).toBe(before)
    expect(existsSync(join(target.root, '.git', 'rebase-apply'))).toBe(false)
  })
})

describe('fixupCommit', () => {
  it('folds the checked paths into the target and keeps unchecked changes in the worktree', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 3)
    repo.write('f1.txt', '1 fixed\n')
    repo.write('f3.txt', '3 unrelated\n')
    const value = await write(fixupCommitOperation, repo, { target: c1, paths: ['f1.txt'], kind: 'fixup', stash: true })
    expect(value).toMatchObject({ completed: true })
    expect(repo.git('log', '--format=%s').trim().split('\n')).toEqual(['c3', 'c2', 'c1', 'initial commit'])
    expect(repo.git('show', 'HEAD~2:f1.txt')).toBe('1 fixed\n')
    expect(readFileSync(join(repo.root, 'f3.txt'), 'utf8')).toBe('3 unrelated\n')
    expect(repo.git('status', '--porcelain').trim()).toBe('M f3.txt')
  })

  it('squashes with an extra message and keeps the target subject', async () => {
    const repo = makeRepo()
    const [, c2] = linear(repo, 3)
    repo.write('f2.txt', '2 squashed\n')
    await write(fixupCommitOperation, repo, { target: c2, paths: ['f2.txt'], kind: 'squash', message: 'why it changed' })
    expect(repo.git('log', '-1', '--skip=1', '--format=%B').trim()).toBe('c2\n\nwhy it changed')
  })

  it('refuses unchecked changes without stash before committing anything', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 2)
    repo.write('f1.txt', 'fixed\n')
    repo.write('f2.txt', 'other\n')
    const head = repo.git('rev-parse', 'HEAD').trim()
    expect((await failureOf(write(fixupCommitOperation, repo, { target: c1, paths: ['f1.txt'], kind: 'fixup' }))).code).toBe('git/dirty-worktree')
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head)
  })

  it('refuses when the range already has fixup!/squash!/amend! commits, before committing (review I3)', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    repo.write('f2.txt', '2 pending\n')
    repo.commit(`fixup! c2`)
    repo.write('f1.txt', '1 new\n')
    const head = repo.git('rev-parse', 'HEAD').trim()
    const failure = await failureOf(write(fixupCommitOperation, repo, { target: c1, paths: ['f1.txt'], kind: 'fixup' }))
    expect(failure).toMatchObject({ code: 'git/invalid-payload', details: { reason: 'pending-autosquash' } })
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head)
    void c2
  })

  it('takes the fixup commit back when the rebase fails without stopping (review I4)', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 2)
    writeExecutableScript(join(repo.root, '.git', 'hooks'), 'pre-rebase', '#!/bin/sh\nexit 1\n')
    const head = repo.git('rev-parse', 'HEAD').trim()
    repo.write('f1.txt', '1 fixed\n')
    const failure = await failureOf(write(fixupCommitOperation, repo, { target: c1, paths: ['f1.txt'], kind: 'fixup' }))
    expect(failure.code).toBe('git/hook-failed')
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(repo.root, 'f1.txt'), 'utf8')).toBe('1 fixed\n')
  })

  it('refuses a target off the current branch', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    const side = sideCommit(repo, 'HEAD~1')
    repo.write('f1.txt', 'x\n')
    expect((await failureOf(write(fixupCommitOperation, repo, { target: side, paths: ['f1.txt'], kind: 'fixup' }))).code).toBe('git/invalid-payload')
  })
})
