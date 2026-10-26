// A3 T10 stash actions: what is sent (always by sha) and how outcomes map to notices.
import { describe, expect, it, vi } from 'vitest'
import {
  applyStash,
  dropStash,
  stashCreateRequest,
  stashOutcomeEffect,
  submitStashCreate,
} from '../../../src/client/pages/stash-actions.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import type { GitError } from '../../../src/shared/protocol.ts'

const SHA = 'a'.repeat(40)
const trigger = { focus() {}, isConnected: true }

function failed(error: GitError): ActionOutcome<unknown> {
  return { kind: 'failed', error, message: text('action.error.fallback', { code: error.code, message: error.message }) }
}

function actionsOf(outcome: ActionOutcome<unknown>) {
  const run = vi.fn(async () => outcome)
  return { run: run as never, calls: run }
}

describe('stashCreateRequest', () => {
  it('omits a blank message so the Host writes its default', () => {
    expect(stashCreateRequest({ message: '  ', includeUntracked: false, keepIndex: false })).toEqual({ includeUntracked: false, keepIndex: false })
    expect(stashCreateRequest({ message: ' wip ', includeUntracked: true, keepIndex: true })).toEqual({ message: 'wip', includeUntracked: true, keepIndex: true })
  })
})

describe('submitStashCreate', () => {
  const form = { message: '', includeUntracked: true, keepIndex: false }

  it('sends stashCreate with the clicked trigger and closes on success', async () => {
    const a = actionsOf({ kind: 'done', value: { sha: SHA, message: 'WIP' } })
    const result = await submitStashCreate({ actions: a, trigger }, form)
    expect(a.calls).toHaveBeenCalledWith('stashCreate', { includeUntracked: true, keepIndex: false }, { trigger })
    expect(result.kind).toBe('closed')
  })

  it('nothing-to-stash stays in the form with the dedicated text', async () => {
    const a = actionsOf(failed({ code: 'git/invalid-payload', message: 'x', details: { reason: 'nothing-to-stash' } }))
    expect(await submitStashCreate({ actions: a, trigger }, form)).toEqual({ kind: 'error', message: text('stash.nothing') })
  })

  it('other failures keep the action message; a cancelled run stays', async () => {
    const other = failed({ code: 'git/timeout', message: 'slow' })
    const result = await submitStashCreate({ actions: actionsOf(other), trigger }, form)
    expect(result).toMatchObject({ kind: 'error' })
    expect(await submitStashCreate({ actions: actionsOf({ kind: 'cancelled' }), trigger }, form)).toEqual({ kind: 'stay' })
  })
})

describe('apply / pop / drop address the stash by sha', () => {
  it('apply keeps the stash, pop removes it', async () => {
    const a = actionsOf({ kind: 'done', value: {} })
    await applyStash({ actions: a, trigger }, SHA, false)
    await applyStash({ actions: a, trigger }, SHA, true)
    expect(a.calls).toHaveBeenNthCalledWith(1, 'stashApply', { sha: SHA, pop: false }, { trigger })
    expect(a.calls).toHaveBeenNthCalledWith(2, 'stashApply', { sha: SHA, pop: true }, { trigger })
  })

  it('drop sends stashDrop with the sha', async () => {
    const a = actionsOf({ kind: 'done', value: {} })
    await dropStash({ actions: a, trigger }, SHA)
    expect(a.calls).toHaveBeenCalledWith('stashDrop', { sha: SHA }, { trigger })
  })
})

describe('stashOutcomeEffect', () => {
  it('success refreshes the list silently', () => {
    expect(stashOutcomeEffect({ kind: 'done', value: {} })).toEqual({ notice: null, refresh: true })
  })

  it('a conflict says the stash is kept (the conflict list is opened by the action store)', () => {
    const effect = stashOutcomeEffect({ kind: 'conflict', error: { code: 'git/conflict', message: 'c' }, details: { operation: 'stash', conflicts: 1, stashKept: true } as never })
    expect(effect).toEqual({ notice: { tone: 'warning', message: text('stash.notice.conflictKept') }, refresh: true })
  })

  it('stale-target refreshes and says the list changed', () => {
    const effect = stashOutcomeEffect(failed({ code: 'git/stale-target', message: 's', details: { target: 'stash' } }))
    expect(effect).toEqual({ notice: { tone: 'warning', message: text('stash.notice.changed') }, refresh: true })
  })

  it('other failures show the error and cancelled does nothing', () => {
    const outcome = failed({ code: 'git/timeout', message: 'slow' })
    expect(stashOutcomeEffect(outcome)).toEqual({ notice: { tone: 'error', message: outcome.kind === 'failed' ? outcome.message : text('notice.dismiss') }, refresh: false })
    expect(stashOutcomeEffect({ kind: 'cancelled' })).toEqual({ notice: null, refresh: false })
  })
})

describe('stashOutcomeEffect / partial apply (final review 3)', () => {
  const SHA_X = 'f'.repeat(40)
  it('pop whose entry could not be dropped warns not to pop again', () => {
    expect(stashOutcomeEffect({ kind: 'done', value: { sha: SHA_X, dropped: false, indexRestored: true } }, true))
      .toEqual({ notice: { tone: 'warning', message: text('stash.notice.notDropped') }, refresh: true })
  })
  it('apply never expects a drop', () => {
    expect(stashOutcomeEffect({ kind: 'done', value: { sha: SHA_X, dropped: false, indexRestored: true } }, false))
      .toEqual({ notice: null, refresh: true })
  })
  it('index not restored says the changes are all in the working tree', () => {
    expect(stashOutcomeEffect({ kind: 'done', value: { sha: SHA_X, dropped: false, indexRestored: false } }, false))
      .toEqual({ notice: { tone: 'warning', message: text('stash.notice.indexNotRestored') }, refresh: true })
  })
  it('both at once: one notice with the second as detail', () => {
    expect(stashOutcomeEffect({ kind: 'done', value: { sha: SHA_X, dropped: false, indexRestored: false } }, true))
      .toEqual({ notice: { tone: 'warning', message: text('stash.notice.notDropped'), detail: text('stash.notice.indexNotRestored') }, refresh: true })
  })
})
