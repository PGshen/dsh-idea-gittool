// A3 T9 operation actions: banner control, finishing from the conflict list / commit page,
// resolving a file (markers confirmation, stale target) and how outcomes map to notices.
import { describe, expect, it, vi } from 'vitest'
import {
  controlOperation,
  finishOperation,
  mergeMessageOf,
  mergePrefill,
  operationBusy,
  operationOutcomeEffect,
  resolveConflictFile,
  submitOperationStep,
} from '../../../src/client/pages/operation-actions.ts'
import type { FocusTarget } from '../../../src/client/focus.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { ActionOutcome, ActionStore } from '../../../src/client/store/action-store.ts'
import type { GitError } from '../../../src/shared/protocol.ts'
import { mergeState, pickState, rebaseState } from './operation-fixtures.ts'

const trigger: FocusTarget = { focus: () => undefined, isConnected: true }

function fakeActions(outcomes: ActionOutcome<unknown>[]) {
  const run = vi.fn(async () => outcomes.shift() ?? { kind: 'done' as const, value: {} })
  return { actions: { run } as unknown as Pick<ActionStore, 'run'>, run }
}

const failed = (code: GitError['code'], details?: Record<string, unknown>): ActionOutcome<unknown> => ({
  kind: 'failed',
  error: details === undefined ? { code, message: code } : { code, message: code, details },
  message: text('action.error.fallback', { code, message: code }),
})

describe('controlOperation / finishOperation / submitOperationStep', () => {
  it('banner actions send operationControl with the click trigger', async () => {
    const { actions, run } = fakeActions([])
    await controlOperation({ actions, trigger }, 'skip')
    expect(run).toHaveBeenCalledWith('operationControl', { action: 'skip' }, { trigger })
  })

  it('finish: merge commits with the message, the others continue', async () => {
    const { actions, run } = fakeActions([])
    await finishOperation({ actions, trigger }, mergeState(), 'Merge it  \n')
    expect(run).toHaveBeenLastCalledWith('operationCommit', { message: 'Merge it' }, { trigger })
    for (const value of [rebaseState(), pickState('cherry-pick'), pickState('revert')]) {
      await finishOperation({ actions, trigger }, value, 'ignored')
      expect(run).toHaveBeenLastCalledWith('operationControl', { action: 'continue' }, { trigger })
    }
  })

  it('commit page step: merge → operationCommit, sequencer/rebase → continue', async () => {
    const { actions, run } = fakeActions([])
    await submitOperationStep({ actions, trigger }, 'merge', 'msg')
    expect(run).toHaveBeenLastCalledWith('operationCommit', { message: 'msg' }, { trigger })
    await submitOperationStep({ actions, trigger }, 'sequencer', 'msg')
    expect(run).toHaveBeenLastCalledWith('operationControl', { action: 'continue' }, { trigger })
    await submitOperationStep({ actions, trigger }, 'rebase', 'msg')
    expect(run).toHaveBeenLastCalledWith('operationControl', { action: 'continue' }, { trigger })
  })

  it('merge message: the edited text, else MERGE_MSG, else a git-style default', () => {
    expect(mergeMessageOf(mergeState(), 'mine')).toBe('mine')
    expect(mergeMessageOf(mergeState(), '  ')).toBe("Merge branch 'feature' into main")
    const noMessage = { ...mergeState(), theirs: { label: 'x' } }
    delete noMessage.message
    expect(mergeMessageOf(noMessage, '')).toBe("Merge branch 'x' into main")
  })
})

describe('resolveConflictFile', () => {
  it('sends the resolution for the path; success → done', async () => {
    const { actions, run } = fakeActions([{ kind: 'done', value: { path: 'a', remaining: 1 } }])
    expect(await resolveConflictFile({ actions, trigger }, 'a', 'theirs')).toEqual({ kind: 'done' })
    expect(run).toHaveBeenCalledWith('resolveConflict', { path: 'a', resolution: 'theirs' }, { trigger })
  })

  it('mark resolved with conflict markers asks; the confirmed resend carries force', async () => {
    const markers: ActionOutcome<unknown> = { kind: 'conflict', error: { code: 'git/conflict', message: 'm', details: { markers: true } }, details: { markers: true } }
    const { actions, run } = fakeActions([markers, { kind: 'done', value: { path: 'a', remaining: 0 } }])
    expect(await resolveConflictFile({ actions, trigger }, 'a', 'mark-resolved')).toEqual({ kind: 'markers', path: 'a' })
    expect(await resolveConflictFile({ actions, trigger }, 'a', 'mark-resolved', true)).toEqual({ kind: 'done' })
    expect(run).toHaveBeenLastCalledWith('resolveConflict', { path: 'a', resolution: 'mark-resolved', force: true }, { trigger })
  })

  it('a path no longer in the list is a stale target (the caller refreshes)', async () => {
    const { actions } = fakeActions([failed('git/stale-target', { target: 'conflict', expected: 'a' })])
    const result = await resolveConflictFile({ actions, trigger }, 'a', 'ours')
    expect(result).toMatchObject({ kind: 'error', stale: true })
  })

  it('other failures keep their message; cancelled stays', async () => {
    const { actions } = fakeActions([failed('git/locked'), { kind: 'cancelled' }])
    expect(await resolveConflictFile({ actions, trigger }, 'a', 'ours')).toMatchObject({ kind: 'error' })
    expect(await resolveConflictFile({ actions, trigger }, 'a', 'ours')).toEqual({ kind: 'stay' })
  })
})

describe('operationOutcomeEffect', () => {
  const head = '9'.repeat(40)

  it('continue that finished: show the new HEAD in the log', () => {
    expect(operationOutcomeEffect({ kind: 'done', value: { operation: null, head } }, 'continue'))
      .toEqual({ notice: null, finished: true, showInLog: head, refreshConflicts: false })
  })

  it('continue still in progress (e.g. next rebase step) keeps the page', () => {
    expect(operationOutcomeEffect({ kind: 'done', value: { operation: 'rebase', head } }, 'continue'))
      .toMatchObject({ finished: false, showInLog: null })
  })

  it('merge commit always finishes and highlights the commit', () => {
    expect(operationOutcomeEffect({ kind: 'done', value: { sha: head, shortSha: '9999999' } }, 'commit'))
      .toMatchObject({ finished: true, showInLog: head })
  })

  it('abort finishes without jumping in the log', () => {
    expect(operationOutcomeEffect({ kind: 'done', value: { operation: null, head } }, 'abort'))
      .toMatchObject({ finished: true, showInLog: null })
  })

  it('stopped at the next conflict: refresh the list, no notice', () => {
    expect(operationOutcomeEffect({ kind: 'conflict', error: { code: 'git/conflict', message: '' }, details: { conflicts: 2 } }, 'continue'))
      .toEqual({ notice: null, finished: false, showInLog: null, refreshConflicts: true })
  })

  it('stash kept / missing / error are told; restored is silent', () => {
    const kept = operationOutcomeEffect({ kind: 'done', value: { operation: null, head, stashKept: true } }, 'abort')
    expect(kept.notice).toEqual({ tone: 'warning', message: text('operation.notice.stashKept'), action: 'goStash' })
    const missing = operationOutcomeEffect({ kind: 'done', value: { operation: null, head, stashMissing: true } }, 'continue')
    expect(missing.notice).toEqual({ tone: 'warning', message: text('operation.notice.stashMissing') })
    const error = operationOutcomeEffect({ kind: 'done', value: { sha: head, shortSha: 'x', stashKept: true, stashError: 'bad' } }, 'commit')
    expect(error.notice).toEqual({ tone: 'warning', message: text('operation.notice.stashError', { message: 'bad' }), action: 'goStash' })
    expect(operationOutcomeEffect({ kind: 'done', value: { operation: null, head, stashRestored: true } }, 'continue').notice).toBeNull()
  })

  it('failure is an error notice; cancelled does nothing', () => {
    const outcome = failed('git/locked')
    expect(operationOutcomeEffect(outcome, 'continue')).toMatchObject({ finished: false, notice: { tone: 'error' } })
    expect(operationOutcomeEffect({ kind: 'cancelled' }, 'continue')).toEqual({ notice: null, finished: false, showInLog: null, refreshConflicts: false })
  })
})

describe('operationBusy', () => {
  it('true while an operation control or commit is pending', () => {
    expect(operationBusy({})).toBe(false)
    expect(operationBusy({ 'fetch:{}': 'running' })).toBe(false)
    expect(operationBusy({ 'operationControl:{"action":"continue"}': 'running' })).toBe(true)
    expect(operationBusy({ 'operationCommit:{"message":"x"}': 'running' })).toBe(true)
  })
})

describe('carry 10: commit page merge prefill', () => {
  it('uses MERGE_MSG, else git\'s default wording from the side labels; nothing outside a merge', () => {
    expect(mergePrefill(mergeState())).toBe("Merge branch 'feature' into main")
    expect(mergePrefill(mergeState({ message: 'Custom MERGE_MSG' }))).toBe('Custom MERGE_MSG')
    const withoutMessage = mergeState()
    delete withoutMessage.message
    expect(mergePrefill(withoutMessage)).toBe("Merge branch 'feature' into main")
    expect(mergePrefill(mergeState({ theirs: { label: 'topic' }, ours: { label: 'dev' }, message: '  ' }))).toBe("Merge branch 'topic' into dev")
    expect(mergePrefill(rebaseState())).toBeUndefined()
    expect(mergePrefill(null)).toBeUndefined()
  })
})
