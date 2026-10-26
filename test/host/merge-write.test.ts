// B1 T3：mergeDraftSave / mergeApply / unresolveConflict 与草稿清理（真实临时仓库）。
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext, WriteOperation } from '../../src/host/git-executor.ts'
import { resolveConflictOperation } from '../../src/host/git/conflict.ts'
import { mergeDraftRef, readMergeFile } from '../../src/host/git/merge-file.ts'
import {
  MERGE_APPLY_RESULT_MAX_BYTES,
  mergeApplyOperation,
  mergeDraftSaveOperation,
  unresolveConflictOperation,
} from '../../src/host/git/merge-write.ts'
import { operationCommitOperation, operationControlOperation } from '../../src/host/git/operation.ts'
import { deleteRefs, readJsonRef, writeJsonRef } from '../../src/host/git/write-support.ts'
import type { MergeDraft, MergeFileValue } from '../../src/shared/protocol.ts'
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

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  return 'ok'
}

async function run<I, V extends object>(op: WriteOperation<I, V>, ctx: WriteContext, payload: Record<string, unknown>): Promise<V> {
  return await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', ...payload }))
}

/** main and feature diverge on every file; the merge stops with conflicts. */
function mergeStopped(repo: TempRepo): void {
  repo.write('uu.txt', 'a\nb\nc\n')
  repo.write('du.txt', 'base du\n')
  repo.write('other.txt', 'a\nb\nc\n')
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('uu.txt', 'a\nfeature\nc\n')
  repo.write('du.txt', 'feature du\n')
  repo.write('other.txt', 'a\nfeature\nc\n')
  repo.commit('feature side')
  repo.git('checkout', '-q', 'main')
  repo.write('uu.txt', 'a\nmain\nc\n')
  repo.git('rm', '-q', 'du.txt')
  repo.write('other.txt', 'a\nmain\nc\n')
  repo.commit('main side')
  expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
}

function draftOf(value: MergeFileValue | Omit<MergeFileValue, 'version'>, result = 'a\nmid\nc\n'): MergeDraft {
  return {
    version: 1,
    stages: { base: value.base?.blob ?? null, ours: value.ours?.blob ?? null, theirs: value.theirs?.blob ?? null },
    result,
    chunks: [{ state: 'edited', leftDone: true, rightDone: false }],
    savedAt: '2026-10-26T00:00:00.000Z',
  }
}

async function applyPayload(ctx: WriteContext, path: string, result: string): Promise<Record<string, unknown>> {
  const file = await readMergeFile(ctx, path)
  return {
    path,
    result,
    stages: draftOf(file).stages,
    expectedWorktreeSha: file.worktreeSha,
  }
}

function refExists(repo: TempRepo, ref: string): boolean {
  return repo.gitResult('rev-parse', '-q', '--verify', ref).status === 0
}

function draftRefs(repo: TempRepo): string[] {
  return repo.git('for-each-ref', '--format=%(refname)', 'refs/worktree/dsh-git/merge-draft/').split('\n').filter((r) => r !== '')
}

describe('write-support ref helpers', () => {
  it('writeJsonRef round-trips through readJsonRef; deleteRefs removes by prefix and honors keep', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'x\n')
    repo.commit('seed')
    const ctx = contextFor(repo)
    await writeJsonRef(ctx, 'refs/worktree/t/one', { n: 1 })
    await writeJsonRef(ctx, 'refs/worktree/t/two', { n: 2 })
    expect(await readJsonRef(ctx, 'refs/worktree/t/one')).toEqual({ n: 1 })
    expect(await deleteRefs(ctx, 'refs/worktree/t/', new Set(['refs/worktree/t/two']))).toBe(1)
    expect(await readJsonRef(ctx, 'refs/worktree/t/one')).toBeNull()
    expect(await readJsonRef(ctx, 'refs/worktree/t/two')).toEqual({ n: 2 })
    expect(await deleteRefs(ctx, 'refs/worktree/t/')).toBe(1)
    expect(await deleteRefs(ctx, 'refs/worktree/t/')).toBe(0)
  })
})

describe('mergeDraftSave', () => {
  it('saves a draft that mergeFile reads back identically', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const draft = draftOf(await readMergeFile(ctx, 'uu.txt'))
    expect(await run(mergeDraftSaveOperation, ctx, { path: 'uu.txt', draft })).toEqual({ path: 'uu.txt' })
    const value = await readMergeFile(ctx, 'uu.txt')
    expect(value.draft).toEqual(draft)
    expect(value.draftStale).toBe(false)
    // A second save replaces the first.
    const second = { ...draft, result: 'x\n' }
    await run(mergeDraftSaveOperation, ctx, { path: 'uu.txt', draft: second })
    expect((await readMergeFile(ctx, 'uu.txt')).draft?.result).toBe('x\n')
  })

  it('rejects a draft whose stages differ from the index (stale-target, nothing stored)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const draft = draftOf(await readMergeFile(ctx, 'uu.txt'))
    draft.stages.theirs = 'f'.repeat(40)
    expect(await failureOf(run(mergeDraftSaveOperation, ctx, { path: 'uu.txt', draft }))).toMatchObject({
      code: 'git/stale-target',
      details: { target: 'conflict' },
    })
    expect(draftRefs(repo)).toEqual([])
  })

  it('rejects a path that is not a conflict and malformed drafts', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    repo.write('plain.txt', 'p\n')
    const ctx = contextFor(repo)
    const draft = draftOf(await readMergeFile(ctx, 'uu.txt'))
    expect((await failureOf(run(mergeDraftSaveOperation, ctx, { path: 'plain.txt', draft }))).code).toBe('git/stale-target')
    for (const bad of [null, 'x', { ...draft, version: 2 }, { ...draft, result: 1 }, { ...draft, chunks: 'no' }, { ...draft, chunks: [{ state: 'nope', leftDone: true, rightDone: true }] }, { ...draft, stages: null }]) {
      expect(codeOf(() => mergeDraftSaveOperation.parse({ sessionId: 's', requestId: 'r', path: 'uu.txt', draft: bad }))).toBe(
        'git/invalid-payload',
      )
    }
    expect(codeOf(() => mergeDraftSaveOperation.parse({ sessionId: 's', requestId: 'r', path: '../x', draft }))).toBe(
      'git/invalid-payload',
    )
  })
})

describe('mergeApply', () => {
  it('writes the result through the index: stage 0 only, blob and worktree equal the result, draft gone', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await run(mergeDraftSaveOperation, ctx, { path: 'uu.txt', draft: draftOf(await readMergeFile(ctx, 'uu.txt')) })
    expect(refExists(repo, mergeDraftRef('uu.txt'))).toBe(true)

    const result = 'a\nboth\nc\n'
    const value = await run(mergeApplyOperation, ctx, await applyPayload(ctx, 'uu.txt', result))
    expect(value).toEqual({ path: 'uu.txt', remaining: 2 })
    const staged = repo.git('ls-files', '-s', '--', 'uu.txt').trim().split('\n')
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatch(/^100644 [0-9a-f]{40} 0\tuu\.txt$/)
    expect(repo.git('show', ':uu.txt')).toBe(result)
    expect(readFileSync(join(repo.root, 'uu.txt'), 'utf8')).toBe(result)
    expect(refExists(repo, mergeDraftRef('uu.txt'))).toBe(false)
    // No worktree-only change is left behind.
    expect(repo.git('status', '--porcelain=v1', '--', 'uu.txt')).toBe('M  uu.txt\n')
  })

  it('keeps the executable bit of the conflict', async () => {
    const repo = makeRepo()
    const exec = (body: string) => {
      repo.write('run.sh', body)
      chmodSync(join(repo.root, 'run.sh'), 0o755)
    }
    exec('#!/bin/sh\necho a\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    exec('#!/bin/sh\necho feature\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    exec('#!/bin/sh\necho main\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    await run(mergeApplyOperation, ctx, await applyPayload(ctx, 'run.sh', '#!/bin/sh\necho both\n'))
    expect(repo.git('ls-files', '-s', '--', 'run.sh')).toMatch(/^100755 /)
    expect(statSync(join(repo.root, 'run.sh')).mode & 0o111).not.toBe(0)
  })

  it('refuses when the index stages changed since the window loaded (stale-target, nothing written)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const payload = await applyPayload(ctx, 'uu.txt', 'x\n')
    ;(payload.stages as { theirs: string }).theirs = 'f'.repeat(40)
    expect(await failureOf(run(mergeApplyOperation, ctx, payload))).toMatchObject({
      code: 'git/stale-target',
      details: { target: 'conflict' },
    })
    expect(repo.git('ls-files', '-u', '--', 'uu.txt')).not.toBe('')
  })

  it('refuses when the worktree file changed after loading (AC12), without overwriting it', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const payload = await applyPayload(ctx, 'uu.txt', 'x\n')
    writeFileSync(join(repo.root, 'uu.txt'), 'agent wrote this\n')
    expect(await failureOf(run(mergeApplyOperation, ctx, payload))).toMatchObject({
      code: 'git/stale-target',
      details: { target: 'conflict', reason: 'worktree-changed' },
    })
    expect(readFileSync(join(repo.root, 'uu.txt'), 'utf8')).toBe('agent wrote this\n')
    expect(repo.git('ls-files', '-u', '--', 'uu.txt')).not.toBe('')
  })

  it('writes CRLF into the worktree and LF into the index under core.autocrlf=true', async () => {
    const repo = makeRepo()
    repo.git('config', 'core.autocrlf', 'true')
    repo.write('crlf.txt', 'a\r\nb\r\nc\r\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('crlf.txt', 'a\r\nfeature\r\nc\r\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('crlf.txt', 'a\r\nmain\r\nc\r\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    await run(mergeApplyOperation, ctx, await applyPayload(ctx, 'crlf.txt', 'a\nboth\nc\n'))
    expect(repo.git('show', ':crlf.txt')).toBe('a\nboth\nc\n')
    expect(readFileSync(join(repo.root, 'crlf.txt'), 'utf8')).toBe('a\r\nboth\r\nc\r\n')
    expect(repo.git('ls-files', '-u')).toBe('')
  })

  it('rejects results over 8 MiB at parse time and malformed payloads', async () => {
    const stages = { base: null, ours: null, theirs: null }
    const base = { sessionId: 's', requestId: 'r', path: 'a.txt', stages, expectedWorktreeSha: null }
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 'x'.repeat(MERGE_APPLY_RESULT_MAX_BYTES + 1) }))).toBe(
      'git/invalid-payload',
    )
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 'ok\n' }))).toBe('ok')
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 1 }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 'x', expectedWorktreeSha: 5 }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 'x', stages: { base: null } }))).toBe('git/invalid-payload')
    expect(codeOf(() => mergeApplyOperation.parse({ ...base, result: 'a\0b' }))).toBe('git/invalid-payload')
  })

  it('re-applies a resolved path from resolve-undo (Review Changes)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await run(resolveConflictOperation, ctx, { path: 'uu.txt', resolution: 'ours' })
    const file = await readMergeFile(ctx, 'uu.txt')
    expect(file.resolved).toBe(true)
    const value = await run(mergeApplyOperation, ctx, await applyPayload(ctx, 'uu.txt', 'a\nreviewed\nc\n'))
    expect(value.remaining).toBe(2)
    expect(repo.git('show', ':uu.txt')).toBe('a\nreviewed\nc\n')
    expect(readFileSync(join(repo.root, 'uu.txt'), 'utf8')).toBe('a\nreviewed\nc\n')
    expect(repo.git('ls-files', '-u', '--', 'uu.txt')).toBe('')
  })

  it('rejects a path that is not a conflict', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    repo.write('plain.txt', 'p\n')
    const ctx = contextFor(repo)
    const payload = { path: 'plain.txt', result: 'x\n', stages: { base: null, ours: null, theirs: null }, expectedWorktreeSha: null }
    expect((await failureOf(run(mergeApplyOperation, ctx, payload))).code).toBe('git/stale-target')
  })
})

describe('unresolveConflict', () => {
  it('restores an applied merge conflict (markers back, index unmerged) and keeps the draft', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await run(mergeApplyOperation, ctx, await applyPayload(ctx, 'uu.txt', 'a\nboth\nc\n'))
    expect(repo.git('ls-files', '-u', '--', 'uu.txt')).toBe('')
    await run(mergeDraftSaveOperation, ctx, { path: 'uu.txt', draft: draftOf(await readMergeFile(ctx, 'uu.txt')) })

    expect(await run(unresolveConflictOperation, ctx, { path: 'uu.txt' })).toEqual({ path: 'uu.txt', remaining: 3 })
    expect(repo.git('ls-files', '-u', '--', 'uu.txt').trim().split('\n')).toHaveLength(3)
    expect(readFileSync(join(repo.root, 'uu.txt'), 'utf8')).toContain('<<<<<<<')
    expect(refExists(repo, mergeDraftRef('uu.txt'))).toBe(true)
    // The window can load it again, draft intact.
    expect((await readMergeFile(ctx, 'uu.txt')).draft).not.toBeNull()
  })

  it('restores a rebase conflict resolved with A3 "ours"', async () => {
    const repo = makeRepo()
    repo.write('f.txt', 'a\nb\nc\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'topic')
    repo.write('f.txt', 'a\ntopic\nc\n')
    repo.commit('topic')
    repo.git('checkout', '-q', 'main')
    repo.write('f.txt', 'a\nmain\nc\n')
    repo.commit('main')
    repo.git('checkout', '-q', 'topic')
    expect(repo.gitResult('rebase', 'main').status).not.toBe(0)
    const ctx = contextFor(repo)
    await run(resolveConflictOperation, ctx, { path: 'f.txt', resolution: 'ours' })
    expect(repo.git('ls-files', '-u')).toBe('')
    expect(await run(unresolveConflictOperation, ctx, { path: 'f.txt' })).toEqual({ path: 'f.txt', remaining: 1 })
    expect(repo.git('ls-files', '-u').trim().split('\n')).toHaveLength(3)
  })

  it('answers stale-target for an unresolved or never-conflicted path', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    repo.write('plain.txt', 'p\n')
    const ctx = contextFor(repo)
    for (const path of ['uu.txt', 'plain.txt', 'missing.txt']) {
      expect(await failureOf(run(unresolveConflictOperation, ctx, { path }))).toMatchObject({
        code: 'git/stale-target',
        details: { target: 'conflict' },
      })
    }
  })

  it('answers exec-failed (resolve in a terminal) for a resolved delete-kind conflict', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await run(resolveConflictOperation, ctx, { path: 'du.txt', resolution: 'delete' })
    const failure = await failureOf(run(unresolveConflictOperation, ctx, { path: 'du.txt' }))
    expect(failure.code).toBe('git/exec-failed')
    expect(failure.message).toMatch(/terminal/i)
    // Nothing changed: still resolved.
    expect(repo.git('ls-files', '-u', '--', 'du.txt')).toBe('')
  })

  it('does nothing once the operation has ended', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    for (const path of ['uu.txt', 'other.txt']) await run(resolveConflictOperation, ctx, { path, resolution: 'ours' })
    await run(resolveConflictOperation, ctx, { path: 'du.txt', resolution: 'delete' })
    repo.git('commit', '-q', '--no-edit')
    expect((await failureOf(run(unresolveConflictOperation, ctx, { path: 'uu.txt' }))).code).toBe('git/stale-target')
  })
})

describe('draft cleanup when the operation ends', () => {
  async function saveDrafts(repo: TempRepo, ctx: WriteContext, paths: string[]): Promise<void> {
    for (const path of paths) {
      await run(mergeDraftSaveOperation, ctx, { path, draft: draftOf(await readMergeFile(ctx, path)) })
    }
    expect(draftRefs(repo)).toHaveLength(paths.length)
  }

  it('abort removes every draft', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await saveDrafts(repo, ctx, ['uu.txt', 'other.txt'])
    await run(operationControlOperation, ctx, { action: 'abort' })
    expect(draftRefs(repo)).toEqual([])
  })

  it('continue that finishes the merge removes the drafts', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await saveDrafts(repo, ctx, ['uu.txt'])
    for (const path of ['uu.txt', 'other.txt']) await run(resolveConflictOperation, ctx, { path, resolution: 'ours' })
    await run(resolveConflictOperation, ctx, { path: 'du.txt', resolution: 'delete' })
    await run(operationControlOperation, ctx, { action: 'continue' })
    expect(draftRefs(repo)).toEqual([])
  })

  it('operationCommit removes the drafts', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    await saveDrafts(repo, ctx, ['uu.txt'])
    for (const path of ['uu.txt', 'other.txt']) await run(resolveConflictOperation, ctx, { path, resolution: 'ours' })
    await run(resolveConflictOperation, ctx, { path: 'du.txt', resolution: 'delete' })
    await run(operationCommitOperation, ctx, { message: 'merge done' })
    expect(draftRefs(repo)).toEqual([])
  })

  it('a rebase continue that stops on the next conflict drops drafts of paths no longer in conflict', async () => {
    const repo = makeRepo()
    repo.write('f1.txt', 'a\nb\nc\n')
    repo.write('f2.txt', 'a\nb\nc\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'topic')
    repo.write('f1.txt', 'a\ntopic1\nc\n')
    repo.commit('topic 1')
    repo.write('f2.txt', 'a\ntopic2\nc\n')
    repo.commit('topic 2')
    repo.git('checkout', '-q', 'main')
    repo.write('f1.txt', 'a\nmain1\nc\n')
    repo.write('f2.txt', 'a\nmain2\nc\n')
    repo.commit('main')
    repo.git('checkout', '-q', 'topic')
    expect(repo.gitResult('rebase', 'main').status).not.toBe(0)
    const ctx = contextFor(repo)
    await saveDrafts(repo, ctx, ['f1.txt'])
    await run(resolveConflictOperation, ctx, { path: 'f1.txt', resolution: 'ours' })
    // Step 2 conflicts on f2.txt: operationControl reports git/conflict but cleanup already ran.
    const failure = await failureOf(run(operationControlOperation, ctx, { action: 'continue' }))
    expect(failure.code).toBe('git/conflict')
    expect(draftRefs(repo)).toEqual([])
  })
})
