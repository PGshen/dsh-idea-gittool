// B1 T8: end-to-end chains on real temporary repositories. The client merge store drives the real
// Host operations (readMergeFile / mergeDraftSave / mergeApply / unresolveConflict) through an
// adapter, so model, store and Host contracts are exercised together without a DOM.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveAllSimple, simpleAllSummary } from '../../src/client/pages/operation-actions.ts'
import { counts } from '../../src/client/merge/merge-model.ts'
import type { MergeModel } from '../../src/client/merge/merge-model.ts'
import type { ActionOutcome } from '../../src/client/store/action-store.ts'
import { createMergeStore } from '../../src/client/store/merge-store.ts'
import type { MergeAction, MergeStore, MergeStoreDeps } from '../../src/client/store/merge-store.ts'
import { text } from '../../src/client/localized-text.ts'
import { GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext, WriteOperation } from '../../src/host/git-executor.ts'
import { resolveConflictOperation } from '../../src/host/git/conflict.ts'
import { mergeDraftRef, readMergeFile } from '../../src/host/git/merge-file.ts'
import { mergeApplyOperation, mergeDraftSaveOperation, unresolveConflictOperation } from '../../src/host/git/merge-write.ts'
import { operationCommitOperation, operationControlOperation } from '../../src/host/git/operation.ts'
import type { FileEntry, WriteEndpoint } from '../../src/shared/protocol.ts'
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

const OPERATIONS: Partial<Record<WriteEndpoint, WriteOperation<unknown, object>>> = {
  mergeDraftSave: mergeDraftSaveOperation as WriteOperation<unknown, object>,
  mergeApply: mergeApplyOperation as WriteOperation<unknown, object>,
  unresolveConflict: unresolveConflictOperation as WriteOperation<unknown, object>,
}

/** A merge store whose loads and writes go straight to the real Host operations. */
function hostDeps(ctx: WriteContext): MergeStoreDeps {
  return {
    loadFile: async (path) => {
      try {
        return { ok: true, value: { ...(await readMergeFile(ctx, path)), version: 1 } }
      } catch (error) {
        if (error instanceof GitCommandFailure) return { ok: false, error: { code: error.code, message: error.message } }
        throw error
      }
    },
    actions: {
      run: (async (endpoint: WriteEndpoint, payload: Record<string, unknown>): Promise<ActionOutcome<unknown>> => {
        const op = OPERATIONS[endpoint]!
        try {
          const value = await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', ...payload }))
          return { kind: 'done', value }
        } catch (error) {
          if (error instanceof GitCommandFailure) {
            return { kind: 'failed', error: { code: error.code, message: error.message, details: error.details }, message: text('merge.error.loadFailed', { code: error.code }) }
          }
          throw error
        }
      }) as never,
    },
  }
}

function hostStore(ctx: WriteContext): MergeStore {
  return createMergeStore(hostDeps(ctx))
}

async function run<I, V extends object>(op: WriteOperation<I, V>, ctx: WriteContext, payload: Record<string, unknown>): Promise<V> {
  return await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', ...payload }))
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

function conflictIds(model: MergeModel): number[] {
  return model.chunks.filter((chunk) => chunk.kind === 'conflict').map((chunk) => chunk.id)
}

function draftRefs(repo: TempRepo): string[] {
  return repo.git('for-each-ref', '--format=%(refname)', 'refs/worktree/dsh-git/merge-draft/').split('\n').filter((r) => r !== '')
}

const BASE = 'l1\nl2\nl3\nl4\nl5\nl6\n'

/** theirs-only change at l1, ours-only at l3, both-sides conflict at l5. */
function seedMerge(repo: TempRepo, withSecond = false): void {
  repo.write('f.txt', BASE)
  if (withSecond) repo.write('g.txt', 'a\nb\nc\n')
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('f.txt', 'F1\nl2\nl3\nl4\nfeature5\nl6\n')
  if (withSecond) repo.write('g.txt', 'a\nfeature\nc\n')
  repo.commit('feature side')
  repo.git('checkout', '-q', 'main')
  repo.write('f.txt', 'l1\nl2\nM3\nl4\nmain5\nl6\n')
  if (withSecond) repo.write('g.txt', 'a\nmain\nc\n')
  repo.commit('main side')
}

async function applyThroughStore(store: MergeStore, path: string, actions: MergeAction[]): Promise<{ remaining: number }> {
  await store.open(path)
  expect(store.getState().status).toBe('ready')
  for (const action of actions) store.dispatch(action)
  const outcome = await store.apply()
  expect(store.getState().error).toBeNull()
  expect(outcome).not.toBeNull()
  return outcome!
}

describe('merge conflict -> window -> commit (AC1, AC2, AC3, AC6)', () => {
  it('resolves block by block through the store, then operationCommit finishes the merge', async () => {
    const repo = makeRepo()
    seedMerge(repo, true)
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    // A saved draft on the second path outlives resolveConflict and must be removed by the commit.
    const other = hostStore(ctx)
    await other.open('g.txt')
    other.dispatch({ type: 'acceptFile', side: 'left' })
    expect(await other.saveAndClose()).toBe(true)
    expect(draftRefs(repo)).toEqual([mergeDraftRef('g.txt')])

    const store = hostStore(ctx)
    await store.open('f.txt')
    const loaded = store.getState().file!
    // AC2: both panes equal the index stages byte for byte.
    expect(loaded.ours?.text).toBe(repo.git('show', ':2:f.txt'))
    expect(loaded.theirs?.text).toBe(repo.git('show', ':3:f.txt'))
    expect(loaded.base?.text).toBe(repo.git('show', ':1:f.txt'))
    // The Result starts from base; the window counts one conflict among the changed blocks.
    const model = store.getState().model!
    expect(model.result).toBe(BASE)
    expect(counts(model).resolved).toBe(0)
    expect(conflictIds(model)).toHaveLength(1)

    store.dispatch({ type: 'applyNonConflicting', which: 'all' })
    const id = conflictIds(store.getState().model!)[0]!
    store.dispatch({ type: 'append', id, order: 'left-first' })
    const state = store.getState()
    expect(counts(state.model!).resolved).toBe(counts(state.model!).total)
    const expected = 'F1\nl2\nM3\nl4\nmain5\nfeature5\nl6\n'
    expect(state.model!.result).toBe(expected)

    const applied = await store.apply()
    expect(applied).toEqual({ remaining: 1 })
    await run(resolveConflictOperation, ctx, { path: 'g.txt', resolution: 'ours' })
    expect(draftRefs(repo)).toEqual([mergeDraftRef('g.txt')])
    // AC3: stage 0 blob and worktree equal the Result; the file moved out of the unresolved list.
    expect(repo.git('ls-files', '-u')).toBe('')
    expect(repo.git('show', ':f.txt')).toBe(expected)
    expect(readFileSync(join(repo.root, 'f.txt'), 'utf8')).toBe(expected)

    expect(repo.gitResult('rev-parse', '-q', '--verify', 'MERGE_HEAD').status).toBe(0)
    await run(operationCommitOperation, ctx, { message: 'Merge feature' })
    expect(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
    expect(repo.git('show', 'HEAD:f.txt')).toBe(expected)
    expect(repo.git('status', '--porcelain=v1')).toBe('')
    expect(draftRefs(repo)).toEqual([])
  })

  it('accepting a whole side with resolveWhole ignores the other side', async () => {
    const repo = makeRepo()
    seedMerge(repo)
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('f.txt')
    const id = conflictIds(store.getState().model!)[0]!
    store.dispatch({ type: 'applyNonConflicting', which: 'all' })
    store.dispatch({ type: 'resolveWhole', id, side: 'right' })
    expect(await store.apply()).toEqual({ remaining: 0 })
    expect(repo.git('show', ':f.txt')).toBe('F1\nl2\nM3\nl4\nfeature5\nl6\n')
  })
})

describe('rebase conflict -> window -> continue (AC1, AC2)', () => {
  it('left is the rebase target (git ours); applying and continuing finishes the rebase', async () => {
    const repo = makeRepo()
    seedMerge(repo, true)
    repo.git('checkout', '-q', 'feature')
    expect(repo.gitResult('rebase', 'main').status).not.toBe(0)
    const ctx = contextFor(repo)
    const other = hostStore(ctx)
    await other.open('g.txt')
    other.dispatch({ type: 'acceptFile', side: 'left' })
    expect(await other.saveAndClose()).toBe(true)

    const store = hostStore(ctx)
    await store.open('f.txt')
    const file = store.getState().file!
    // During a rebase git's ours (:2:) is the branch being rebased onto, theirs is the replayed commit.
    expect(file.ours?.text).toBe('l1\nl2\nM3\nl4\nmain5\nl6\n')
    expect(file.theirs?.text).toBe('F1\nl2\nl3\nl4\nfeature5\nl6\n')
    expect(file.ours?.text).toBe(repo.git('show', ':2:f.txt'))

    store.dispatch({ type: 'applyNonConflicting', which: 'all' })
    const id = conflictIds(store.getState().model!)[0]!
    store.dispatch({ type: 'append', id, order: 'right-first' })
    const expected = 'F1\nl2\nM3\nl4\nfeature5\nmain5\nl6\n'
    expect(await store.apply()).toEqual({ remaining: 1 })
    expect(repo.git('show', ':f.txt')).toBe(expected)
    await run(resolveConflictOperation, ctx, { path: 'g.txt', resolution: 'ours' })
    expect(draftRefs(repo)).toEqual([mergeDraftRef('g.txt')])

    const control = await run(operationControlOperation, ctx, { action: 'continue' })
    expect(control.operation).toBeNull()
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature')
    expect(repo.git('show', 'HEAD:f.txt')).toBe(expected)
    expect(repo.git('rev-parse', 'HEAD~1')).toBe(repo.git('rev-parse', 'main'))
    expect(draftRefs(repo)).toEqual([])
  })
})

describe('cherry-pick conflict -> window -> continue (AC1)', () => {
  it('applies the Result and continues the cherry-pick', async () => {
    const repo = makeRepo()
    seedMerge(repo)
    expect(repo.gitResult('cherry-pick', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('f.txt')
    expect(store.getState().file!.theirs?.text).toBe(repo.git('show', ':3:f.txt'))
    store.dispatch({ type: 'applyNonConflicting', which: 'all' })
    const id = conflictIds(store.getState().model!)[0]!
    store.dispatch({ type: 'accept', id, side: 'right' })
    expect(await store.apply()).toEqual({ remaining: 0 })

    const control = await run(operationControlOperation, ctx, { action: 'continue' })
    expect(control.operation).toBeNull()
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('feature side')
    expect(repo.git('show', 'HEAD:f.txt')).toBe('F1\nl2\nM3\nl4\nfeature5\nl6\n')
  })
})

describe('autocrlf write-back (AC3)', () => {
  it('writes CRLF to the worktree and LF to the index; the window sees LF text', async () => {
    const repo = makeRepo()
    repo.git('config', 'core.autocrlf', 'true')
    repo.write('c.txt', 'a\r\nb\r\nc\r\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('c.txt', 'a\r\nfeature\r\nc\r\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('c.txt', 'a\r\nmain\r\nc\r\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('c.txt')
    expect(store.getState().file!.ours?.text).toBe('a\nmain\nc\n')
    const id = conflictIds(store.getState().model!)[0]!
    store.dispatch({ type: 'append', id, order: 'left-first' })
    expect(await store.apply()).toEqual({ remaining: 0 })
    expect(repo.git('show', ':c.txt')).toBe('a\nmain\nfeature\nc\n')
    expect(readFileSync(join(repo.root, 'c.txt'), 'utf8')).toBe('a\r\nmain\r\nfeature\r\nc\r\n')
  })
})

describe('binary and delete conflicts degrade to choose-one (AC8)', () => {
  function seedMixed(repo: TempRepo): void {
    repo.write('bin.dat', 'base\0bytes\n')
    repo.write('gone.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('bin.dat', 'feature\0bytes\n')
    repo.write('gone.txt', 'feature edit\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('bin.dat', 'main\0bytes\n')
    repo.git('rm', '-q', 'gone.txt')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
  }

  it('a binary conflict loads without a model and resolves via resolveConflict', async () => {
    const repo = makeRepo()
    seedMixed(repo)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('bin.dat')
    expect(store.getState()).toMatchObject({ status: 'ready', model: null })
    expect(store.getState().file).toMatchObject({ kind: 'both-modified', ours: { binary: true, text: null } })
    await run(resolveConflictOperation, ctx, { path: 'bin.dat', resolution: 'theirs' })
    expect(readFileSync(join(repo.root, 'bin.dat'), 'utf8')).toBe('feature\0bytes\n')
    expect(repo.git('ls-files', '-u', '--', 'bin.dat')).toBe('')
  })

  it('a deleted-by-us conflict loads without a model and resolves with delete', async () => {
    const repo = makeRepo()
    seedMixed(repo)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('gone.txt')
    expect(store.getState()).toMatchObject({ status: 'ready', model: null })
    expect(store.getState().file).toMatchObject({ kind: 'deleted-by-us', ours: null })
    await run(resolveConflictOperation, ctx, { path: 'gone.txt', resolution: 'delete' })
    await run(resolveConflictOperation, ctx, { path: 'bin.dat', resolution: 'ours' })
    expect(repo.git('ls-files', '--', 'gone.txt')).toBe('')
    expect(repo.git('ls-files', '-u', '--', 'gone.txt')).toBe('')
    // Both resolved: the merge can be committed.
    await run(operationCommitOperation, ctx, { message: 'Merge feature' })
    expect(repo.git('status', '--porcelain=v1')).toBe('')
  })
})

describe('draft lifecycle (AC7)', () => {
  it('save and close, reopen in a fresh store restores the Result and chunk states, abort cleans', async () => {
    const repo = makeRepo()
    seedMerge(repo)
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)

    const first = hostStore(ctx)
    await first.open('f.txt')
    first.dispatch({ type: 'applyNonConflicting', which: 'left' })
    const savedResult = first.getState().model!.result
    const savedChunks = first.getState().model!.chunks.map((chunk) => ({ id: chunk.id, state: chunk.state }))
    expect(first.getState().dirty).toBe(true)
    expect(await first.saveAndClose()).toBe(true)
    expect(draftRefs(repo)).toEqual([mergeDraftRef('f.txt')])
    // Saving a draft does not touch the worktree or the index.
    expect(repo.git('ls-files', '-u', '--', 'f.txt')).not.toBe('')

    const second = hostStore(ctx)
    await second.open('f.txt')
    expect(second.getState()).toMatchObject({ draftDiscarded: false, dirty: false })
    expect(second.getState().model!.result).toBe(savedResult)
    expect(second.getState().model!.chunks.map((chunk) => ({ id: chunk.id, state: chunk.state }))).toEqual(savedChunks)

    await run(operationControlOperation, ctx, { action: 'abort' })
    expect(draftRefs(repo)).toEqual([])
  })
})

describe('restore conflict resolution (AC9)', () => {
  it('unresolve returns an applied text conflict to unresolved with markers; the draft survives', async () => {
    const repo = makeRepo()
    seedMerge(repo)
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('f.txt')
    store.dispatch({ type: 'acceptFile', side: 'right' })
    expect(await store.saveAndClose()).toBe(true)
    expect(draftRefs(repo)).toEqual([mergeDraftRef('f.txt')])
    const again = hostStore(ctx)
    expect(
      await applyThroughStore(again, 'f.txt', [
        { type: 'applyNonConflicting', which: 'all' },
        { type: 'acceptFile', side: 'left' },
      ]),
    ).toEqual({ remaining: 0 })
    expect(repo.git('ls-files', '-u')).toBe('')
    // Applying removes the file's own draft; a draft saved afterwards must survive unresolve.
    expect(draftRefs(repo)).toEqual([])
    const reopened = hostStore(ctx)
    await reopened.open('f.txt')
    expect(reopened.getState().file!.resolved).toBe(true)
    reopened.dispatch({ type: 'acceptFile', side: 'right' })
    expect(await reopened.saveAndClose()).toBe(true)

    expect(await reopened.unresolve('f.txt')).toEqual({ remaining: 1 })
    expect(repo.git('ls-files', '-u').trim().split('\n')).toHaveLength(3)
    expect(readFileSync(join(repo.root, 'f.txt'), 'utf8')).toContain('<<<<<<<')
    expect(draftRefs(repo)).toEqual([mergeDraftRef('f.txt')])
  })
})

describe('stale worktree and oversized files (AC12)', () => {
  it('apply is refused when the worktree file changed after loading and nothing is overwritten', async () => {
    const repo = makeRepo()
    seedMerge(repo)
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const store = hostStore(ctx)
    await store.open('f.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    writeFileSync(join(repo.root, 'f.txt'), 'agent wrote this\n')
    expect(await store.apply()).toBeNull()
    expect(store.getState().error).toEqual(text('merge.error.stale'))
    expect(readFileSync(join(repo.root, 'f.txt'), 'utf8')).toBe('agent wrote this\n')
    expect(repo.git('ls-files', '-u', '--', 'f.txt')).not.toBe('')
    // Direct Host call carries the contract code.
    const file = await readMergeFile(ctx, 'f.txt')
    writeFileSync(join(repo.root, 'f.txt'), 'agent wrote again\n')
    const failure = await failureOf(
      run(mergeApplyOperation, ctx, {
        path: 'f.txt',
        result: 'x\n',
        stages: { base: file.base?.blob ?? null, ours: file.ours?.blob ?? null, theirs: file.theirs?.blob ?? null },
        expectedWorktreeSha: file.worktreeSha,
      }),
    )
    expect(failure).toMatchObject({ code: 'git/stale-target', details: { reason: 'worktree-changed' } })
  })

  it('a side over 2 MiB makes the window fall back (tooLarge, no model)', async () => {
    const repo = makeRepo()
    const big = (marker: string) => `${'x'.repeat(1023)}\n`.repeat(2100) + marker + '\n'
    repo.write('big.txt', big('base'))
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('big.txt', big('feature'))
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('big.txt', big('main'))
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const store = hostStore(contextFor(repo))
    await store.open('big.txt')
    expect(store.getState().file).toMatchObject({ tooLarge: true })
    expect(store.getState().model).toBeNull()
  })
})

describe('all simple conflicts (AC6)', () => {
  it('writes back only files whose every chunk resolves automatically, with no drafts', async () => {
    const repo = makeRepo()
    repo.write('simple.txt', 'alpha beta gamma\nx\n')
    repo.write('hard.txt', 'alpha beta gamma\nx\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('simple.txt', 'alpha beta GAMMA\nx\n')
    repo.write('hard.txt', 'alpha beta feature\nx\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('simple.txt', 'ALPHA beta gamma\nx\n')
    repo.write('hard.txt', 'alpha beta main\nx\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const ctx = contextFor(repo)
    const deps = hostDeps(ctx)
    const entries: FileEntry[] = ['hard.txt', 'simple.txt'].map((path) => ({ path, status: 'U', conflict: 'both-modified' }))

    const outcome = await resolveAllSimple({ actions: deps.actions, loadFile: deps.loadFile, trigger: null }, entries)
    expect(outcome).toEqual({ resolved: ['simple.txt'], manual: ['hard.txt'] })
    expect(simpleAllSummary(outcome)).toEqual(text('conflict.simpleAll.done', { resolved: 1, manual: 1 }))
    expect(repo.git('ls-files', '-u', '--', 'simple.txt')).toBe('')
    expect(repo.git('show', ':simple.txt')).toBe('ALPHA beta GAMMA\nx\n')
    expect(readFileSync(join(repo.root, 'simple.txt'), 'utf8')).toBe('ALPHA beta GAMMA\nx\n')
    expect(repo.git('ls-files', '-u', '--', 'hard.txt').trim().split('\n')).toHaveLength(3)
    expect(readFileSync(join(repo.root, 'hard.txt'), 'utf8')).toContain('<<<<<<<')
    expect(draftRefs(repo)).toEqual([])
  })
})
