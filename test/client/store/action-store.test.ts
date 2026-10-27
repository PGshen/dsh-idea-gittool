// A3 T6 action store: one write-action pipeline (request → loading → error → smart-stash ask → retry).
// De-duplication of repeated calls, dirty-worktree ask → stash resend with a new requestId,
// cancel without a request, conflict routing, and error code → LocalizedText mapping.
import { describe, expect, it, vi } from 'vitest'
import { en, zh } from '../../../src/client/locales.ts'
import { render } from '../../../src/client/localized-text.ts'
import { zhT } from '../i18n-helpers.tsx'
import type {
  DirtyWorktreeDetails,
  GitError,
  IntegrateValue,
  MergeRequest,
  RpcResult,
  WriteEndpoint,
} from '../../../src/shared/protocol.ts'
import { actionErrorText, actionKey, createActionStore } from '../../../src/client/store/action-store.ts'
import type { ActionClient } from '../../../src/client/store/action-store.ts'

const MERGED: IntegrateValue = { head: 'a'.repeat(40), committed: true }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function dirty(details: DirtyWorktreeDetails): RpcResult<IntegrateValue> {
  return { ok: false, error: { code: 'git/dirty-worktree', message: 'dirty', details: { ...details } } }
}

function fakeClient(overrides: Partial<ActionClient>): ActionClient {
  const notCalled = (name: WriteEndpoint) => () => { throw new Error(`unexpected ${name}`) }
  const client: Record<string, unknown> = {}
  for (const name of [
    'commitFiles', 'amendMessage', 'rollback', 'addToVcs', 'push', 'pullForPush', 'operationControl', 'operationCommit',
    'resolveConflict', 'checkout', 'createBranch', 'renameBranch', 'deleteBranch', 'merge', 'rebase', 'cherryPick',
    'revertCommit', 'reset', 'fetch', 'pull', 'updateProject', 'resetToRemote', 'stashCreate', 'stashApply', 'stashDrop',
  ] as const) client[name] = notCalled(name)
  return { ...(client as unknown as ActionClient), ...overrides }
}

function ids(): () => string {
  let n = 0
  return () => `req-${++n}`
}

describe('createActionStore.run', () => {
  it('sends the payload with sessionId and a fresh requestId, and reports done', async () => {
    const merge = vi.fn(async (_request: MergeRequest) => ({ ok: true, value: MERGED }) as RpcResult<IntegrateValue>)
    const onSuccess = vi.fn()
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids(), onSuccess })

    const outcome = await actions.run('merge', { ref: 'feature' })

    expect(outcome).toEqual({ kind: 'done', value: MERGED })
    expect(merge).toHaveBeenCalledWith({ ref: 'feature', sessionId: 's1', requestId: 'req-1' })
    expect(onSuccess).toHaveBeenCalledWith('merge', MERGED)
    const second = await actions.run('merge', { ref: 'feature' })
    expect(second.kind).toBe('done')
    expect(merge.mock.calls[1]?.[0].requestId).toBe('req-2')
  })

  it('a repeated call for the same endpoint and target returns the in-flight promise without a second request', async () => {
    const pending = deferred<RpcResult<IntegrateValue>>()
    const merge = vi.fn(() => pending.promise)
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })

    const first = actions.run('merge', { ref: 'feature' })
    const again = actions.run('merge', { ref: 'feature' })
    expect(again).toBe(first)
    expect(merge).toHaveBeenCalledTimes(1)
    expect(actions.isRunning('merge', { ref: 'feature' })).toBe(true)
    expect(actions.getState().pending[actionKey('merge', { ref: 'feature' })]).toBe('running')

    // A different target is a different action.
    void actions.run('merge', { ref: 'other' })
    expect(merge).toHaveBeenCalledTimes(2)

    pending.resolve({ ok: true, value: MERGED })
    await first
    expect(actions.isRunning('merge', { ref: 'feature' })).toBe(false)
  })

  it('an explicit target overrides the payload for de-duplication', async () => {
    const pending = deferred<RpcResult<IntegrateValue>>()
    const merge = vi.fn(() => pending.promise)
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })
    const first = actions.run('merge', { ref: 'feature', noFf: true }, { target: 'feature' })
    expect(actions.run('merge', { ref: 'feature' }, { target: 'feature' })).toBe(first)
    pending.resolve({ ok: true, value: MERGED })
    await first
  })

  it('dirty worktree + smartStash → asking-stash; "stash and continue" resends with stash: true and a new requestId', async () => {
    const merge = vi.fn<(request: MergeRequest) => Promise<RpcResult<IntegrateValue>>>()
      .mockResolvedValueOnce(dirty({ operation: 'merge', paths: ['a.ts', 'b.ts'], count: 2 }))
      .mockResolvedValueOnce({ ok: true, value: { ...MERGED, stashRestored: true } })
    const onAskStash = vi.fn()
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids(), onAskStash })

    const outcome = actions.run('merge', { ref: 'feature' }, { smartStash: 'merge' })
    await vi.waitFor(() => { expect(actions.getState().ask).not.toBeNull() })

    const ask = actions.getState().ask
    expect(ask).toMatchObject({ endpoint: 'merge', operation: 'merge', paths: ['a.ts', 'b.ts'], count: 2 })
    expect(onAskStash).toHaveBeenCalledWith(ask)
    expect(actions.getState().pending[actionKey('merge', { ref: 'feature' })]).toBe('asking-stash')

    actions.confirmStash()
    await expect(outcome).resolves.toEqual({ kind: 'done', value: { ...MERGED, stashRestored: true } })
    expect(merge).toHaveBeenCalledTimes(2)
    expect(merge.mock.calls[0]?.[0]).toEqual({ ref: 'feature', sessionId: 's1', requestId: 'req-1' })
    expect(merge.mock.calls[1]?.[0]).toEqual({ ref: 'feature', sessionId: 's1', requestId: 'req-2', stash: true })
    expect(actions.getState().ask).toBeNull()
    expect(actions.getState().pending).toEqual({})
  })

  it('cancel on the ask sends nothing and resolves as cancelled', async () => {
    const merge = vi.fn<(request: MergeRequest) => Promise<RpcResult<IntegrateValue>>>()
      .mockResolvedValueOnce(dirty({ operation: 'merge', paths: ['a.ts'], count: 1 }))
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })

    const outcome = actions.run('merge', { ref: 'feature' }, { smartStash: 'merge' })
    await vi.waitFor(() => { expect(actions.getState().ask).not.toBeNull() })
    actions.cancelStash()

    await expect(outcome).resolves.toEqual({ kind: 'cancelled' })
    expect(merge).toHaveBeenCalledTimes(1)
    expect(actions.getState()).toEqual({ pending: {}, ask: null })
    // Answering again after the ask is gone is a no-op.
    actions.confirmStash()
    expect(merge).toHaveBeenCalledTimes(1)
  })

  it('a duplicate call while asking returns the same promise', async () => {
    const merge = vi.fn<(request: MergeRequest) => Promise<RpcResult<IntegrateValue>>>()
      .mockResolvedValueOnce(dirty({ operation: 'merge', paths: ['a.ts'], count: 1 }))
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })
    const first = actions.run('merge', { ref: 'feature' }, { smartStash: 'merge' })
    await vi.waitFor(() => { expect(actions.getState().ask).not.toBeNull() })
    expect(actions.run('merge', { ref: 'feature' }, { smartStash: 'merge' })).toBe(first)
    actions.cancelStash()
    await first
  })

  it('a new ask replaces an unanswered one, which resolves as cancelled', async () => {
    const merge = vi.fn<(request: MergeRequest) => Promise<RpcResult<IntegrateValue>>>()
      .mockResolvedValue(dirty({ operation: 'merge', paths: ['a.ts'], count: 1 }))
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })
    const first = actions.run('merge', { ref: 'one' }, { smartStash: 'merge' })
    await vi.waitFor(() => { expect(actions.getState().ask).not.toBeNull() })
    const second = actions.run('merge', { ref: 'two' }, { smartStash: 'merge' })
    await expect(first).resolves.toEqual({ kind: 'cancelled' })
    await vi.waitFor(() => { expect(actions.getState().ask?.key).toBe(actionKey('merge', { ref: 'two' })) })
    actions.cancelStash()
    await second
  })

  it('dirty worktree without smartStash is an ordinary failure (e.g. resetToRemote)', async () => {
    const resetToRemote = vi.fn(async () => ({
      ok: false,
      error: { code: 'git/dirty-worktree', message: 'dirty', details: { paths: ['a.ts'], count: 3 } },
    }) as const)
    const actions = createActionStore({ client: fakeClient({ resetToRemote }), sessionId: 's1', newRequestId: ids() })
    const outcome = await actions.run('resetToRemote', {})
    expect(outcome).toMatchObject({ kind: 'failed', message: { key: 'action.error.git/dirty-worktree', params: { count: 3 } } })
    expect(actions.getState().ask).toBeNull()
  })

  it('carry 2: a dirty-worktree answer without details.operation never asks, even with smartStash', async () => {
    const merge = vi.fn(async () => ({
      ok: false,
      error: { code: 'git/dirty-worktree', message: 'dirty', details: { paths: ['out.js'], count: 1 } },
    }) as const)
    const onAskStash = vi.fn()
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids(), onAskStash })
    const outcome = await actions.run('merge', { ref: 'x' }, { smartStash: 'merge' })
    expect(outcome.kind).toBe('failed')
    expect(onAskStash).not.toHaveBeenCalled()
    expect(merge).toHaveBeenCalledTimes(1)
  })

  it('git/conflict → onConflict and a conflict outcome', async () => {
    const error: GitError = { code: 'git/conflict', message: 'conflict', details: { operation: 'merge', conflicts: 2, stashKept: true } }
    const merge = vi.fn(async () => ({ ok: false, error }) as RpcResult<IntegrateValue>)
    const onConflict = vi.fn()
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids(), onConflict })
    const outcome = await actions.run('merge', { ref: 'feature' })
    expect(outcome).toEqual({ kind: 'conflict', error, details: { operation: 'merge', conflicts: 2, stashKept: true } })
    expect(onConflict).toHaveBeenCalledWith('merge', { operation: 'merge', conflicts: 2, stashKept: true }, null)
  })

  it('carries the trigger captured at click time to the ask and to onConflict', async () => {
    const trigger = { focus: vi.fn<() => void>(), isConnected: true }
    const merge = vi.fn<(request: MergeRequest) => Promise<RpcResult<IntegrateValue>>>()
      .mockResolvedValueOnce(dirty({ operation: 'merge', paths: ['a.ts'], count: 1 }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'git/conflict', message: 'c' } })
    const onAskStash = vi.fn()
    const onConflict = vi.fn()
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids(), onAskStash, onConflict })
    const outcome = actions.run('merge', { ref: 'feature' }, { smartStash: 'merge', trigger })
    await vi.waitFor(() => { expect(actions.getState().ask).not.toBeNull() })
    expect(onAskStash.mock.calls[0]?.[0].trigger).toBe(trigger)
    actions.confirmStash()
    await expect(outcome).resolves.toMatchObject({ kind: 'conflict' })
    expect(onConflict).toHaveBeenCalledWith('merge', {}, trigger)
    // The trigger is not part of the de-duplication key and is never sent.
    expect(merge.mock.calls[0]?.[0]).not.toHaveProperty('trigger')
  })

  it('a thrown client call becomes a failed outcome instead of a rejection', async () => {
    const merge = vi.fn(async () => { throw new Error('network down') })
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })
    const outcome = await actions.run('merge', { ref: 'feature' })
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'git/exec-failed', message: 'network down' } })
    expect(actions.getState().pending).toEqual({})
  })

  it('notifies subscribers on state changes', async () => {
    const merge = vi.fn(async () => ({ ok: true, value: MERGED }) as RpcResult<IntegrateValue>)
    const actions = createActionStore({ client: fakeClient({ merge }), sessionId: 's1', newRequestId: ids() })
    const listener = vi.fn()
    const unsubscribe = actions.subscribe(listener)
    await actions.run('merge', { ref: 'feature' })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    await actions.run('merge', { ref: 'feature' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('actionErrorText', () => {
  const error = (code: GitError['code'], details?: Record<string, unknown>): GitError =>
    details === undefined ? { code, message: 'm' } : { code, message: 'm', details }

  it('reuses the A2 texts for hook-failed / auth-required and the other A2 write codes', () => {
    expect(actionErrorText(error('git/hook-failed'))).toEqual({ key: 'write.error.git/hook-failed' })
    expect(actionErrorText(error('git/auth-required', { command: 'git push' }))).toEqual({ key: 'write.error.git/auth-required' })
    expect(actionErrorText(error('git/locked'))).toEqual({ key: 'write.error.git/locked' })
    expect(actionErrorText(error('git/timeout'))).toEqual({ key: 'write.error.git/timeout' })
    expect(actionErrorText(error('git/sandbox-denied'))).toEqual({ key: 'write.error.git/sandbox-denied' })
    expect(actionErrorText(error('git/operation-in-progress'))).toEqual({ key: 'write.error.git/operation-in-progress' })
  })

  it('maps the A3 codes with their details', () => {
    expect(render(zhT, actionErrorText(error('git/not-merged', { branch: 'feat/x' })))).toBe(zh['action.error.git/not-merged'].replace('{branch}', 'feat/x'))
    expect(actionErrorText(error('git/branch-exists', { branch: 'main' }))).toEqual({ key: 'action.error.git/branch-exists', params: { branch: 'main' } })
    expect(actionErrorText(error('git/would-overwrite', { paths: ['a', 'b'] }))).toEqual({ key: 'action.error.git/would-overwrite', params: { count: 2 } })
    expect(actionErrorText(error('git/upstream-rewritten', { oldSha: 'o', newSha: 'n', localAhead: 3 }))).toEqual({ key: 'action.error.git/upstream-rewritten', params: { count: 3 } })
    expect(actionErrorText(error('git/conflict'))).toEqual({ key: 'action.error.git/conflict' })
    expect(actionErrorText(error('git/paths-changed'))).toEqual({ key: 'action.error.git/paths-changed' })
  })

  it('names the stale target kind', () => {
    for (const target of ['stash', 'conflict', 'head', 'branch'] as const) {
      expect(actionErrorText(error('git/stale-target', { target }))).toEqual({ key: `action.error.git/stale-target.${target}` })
    }
    expect(actionErrorText(error('git/stale-target'))).toEqual({ key: 'action.error.git/stale-target' })
  })

  it('invalid payload reasons from the Host get their own text; others fall back', () => {
    expect(actionErrorText(error('git/invalid-payload', { reason: 'nothing-to-stash' }))).toEqual({ key: 'action.error.nothing-to-stash' })
    expect(actionErrorText(error('git/invalid-payload', { reason: 'no-upstream' }))).toEqual({ key: 'action.error.no-upstream' })
    // B1 acceptance demo: a request body over the Host limit reads as "too large, use a terminal".
    expect(actionErrorText(error('git/invalid-payload', { reason: 'body-too-large', limit: 1 }))).toEqual({ key: 'action.error.body-too-large' })
    expect(actionErrorText(error('git/invalid-payload'))).toEqual({ key: 'action.error.fallback', params: { code: 'git/invalid-payload', message: 'm' } })
    expect(actionErrorText(error('git/exec-failed'))).toEqual({ key: 'action.error.fallback', params: { code: 'git/exec-failed', message: 'm' } })
  })

  it('carry 3: an empty cherry-pick / revert points to the banner skip / abort', () => {
    const pick = actionErrorText(error('git/exec-failed', { reason: 'empty', operation: 'cherry-pick' }))
    expect(pick).toEqual({ key: 'action.error.empty' })
    expect(zh['action.error.empty']).toContain('提交为空，请跳过或中止')
    expect(en['action.error.empty']).toMatch(/empty.*Skip.*Abort/s)
    const revert = actionErrorText(error('git/exec-failed', { reason: 'empty', operation: 'revert' }))
    expect(revert).toEqual({ key: 'action.error.empty.abortOnly' })
    expect(zh['action.error.empty.abortOnly']).toContain('提交为空')
    expect(zh['action.error.empty.abortOnly']).toContain('中止')
    expect(zh['action.error.empty.abortOnly']).not.toContain('跳过')
    // Without an operation (nothing to skip / abort) the generic text stays.
    expect(actionErrorText(error('git/exec-failed', { reason: 'empty' })).key).toBe('action.error.fallback')
  })

  it('every mapped key exists in the dictionary', () => {
    const codes: GitError['code'][] = ['git/not-merged', 'git/branch-exists', 'git/would-overwrite', 'git/upstream-rewritten', 'git/dirty-worktree', 'git/conflict', 'git/stale-target', 'git/exec-failed']
    for (const code of codes) expect(zh).toHaveProperty([actionErrorText(error(code)).key])
  })
})

describe('actionErrorText / B3a interactive rebase reasons', () => {
  it('maps the rebase validation reasons to their copy', () => {
    for (const reason of ['not-permutation', 'leading-squash', 'missing-message', 'misplaced-message'] as const) {
      expect(actionErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason } }).key).toBe(`rebase.invalid.${reason}`)
    }
    for (const reason of ['not-ancestor', 'detached', 'empty'] as const) {
      expect(actionErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason } }).key).toBe(`rebase.blocked.${reason}`)
    }
  })
})

describe('actionErrorText / B3b', () => {
  it('names a tag collision as a tag', () => {
    expect(actionErrorText({ code: 'git/branch-exists', message: 'x', details: { kind: 'tag', branch: 'v1' } })).toEqual({ key: 'tag.exists', params: { name: 'v1' } })
    expect(actionErrorText({ code: 'git/branch-exists', message: 'x', details: { branch: 'main' } }).key).toBe('action.error.git/branch-exists')
  })
})
