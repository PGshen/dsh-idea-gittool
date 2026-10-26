// Final review 2b: a pending smart stash left behind when the operation ended outside the UI
// (terminal / Agent). Checked only when the repository version moves while no operation is open.
import { describe, expect, it, vi } from 'vitest'
import { createPendingStashStore, pendingStashCheck } from '../../../src/client/store/pending-stash-store.ts'
import type { OperationStateValue, RpcResult } from '../../../src/shared/protocol.ts'
import { idleState, mergeState } from '../pages/operation-fixtures.ts'

const idle = (pendingStash: boolean): RpcResult<OperationStateValue> => ({ ok: true, value: { ...idleState(), pendingStash } })

describe('pendingStashCheck', () => {
  it('loads only when idle with stashes and the version moved', () => {
    expect(pendingStashCheck(null, { operation: null, version: 1, stashCount: 1 })).toBe('load')
    expect(pendingStashCheck(1, { operation: null, version: 1, stashCount: 1 })).toBe('keep')
    expect(pendingStashCheck(1, { operation: null, version: 2, stashCount: 1 })).toBe('load')
  })
  it('clears while an operation is open (the banner tells it) or when there is no stash at all', () => {
    expect(pendingStashCheck(1, { operation: 'merge', version: 2, stashCount: 1 })).toBe('clear')
    expect(pendingStashCheck(1, { operation: null, version: 2, stashCount: 0 })).toBe('clear')
  })
})

describe('createPendingStashStore', () => {
  it('shows a pending stash after the operation ended elsewhere, without reloading on every poll', async () => {
    const load = vi.fn(async () => idle(true))
    const store = createPendingStashStore({ load })
    await store.sync({ operation: null, version: 3, stashCount: 1 })
    expect(store.getState().pending).toBe(true)
    await store.sync({ operation: null, version: 3, stashCount: 1 })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('is hidden while an operation is open and when the Host answers no pending stash', async () => {
    const results = [idle(true), idle(false)]
    const load = vi.fn(async () => results.shift() ?? idle(false))
    const store = createPendingStashStore({ load })
    await store.sync({ operation: null, version: 1, stashCount: 1 })
    expect(store.getState().pending).toBe(true)
    await store.sync({ operation: 'merge', version: 2, stashCount: 1 })
    expect(store.getState().pending).toBe(false)
    await store.sync({ operation: null, version: 3, stashCount: 1 })
    expect(store.getState().pending).toBe(false)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('ignores an answer that still reports an open operation, and keeps the old value on errors', async () => {
    const results: RpcResult<OperationStateValue>[] = [
      idle(true),
      { ok: false, error: { code: 'git/exec-failed', message: 'x' } },
      { ok: true, value: mergeState({ pendingStash: true }) },
    ]
    const store = createPendingStashStore({ load: async () => results.shift() ?? idle(false) })
    await store.sync({ operation: null, version: 1, stashCount: 1 })
    await store.sync({ operation: null, version: 2, stashCount: 1 })
    expect(store.getState().pending).toBe(true)
    await store.sync({ operation: null, version: 3, stashCount: 1 })
    expect(store.getState().pending).toBe(false)
  })

  it('recheck() reloads at the same version (after a restore attempt)', async () => {
    const results = [idle(true), idle(false)]
    const load = vi.fn(async () => results.shift() ?? idle(false))
    const store = createPendingStashStore({ load })
    await store.sync({ operation: null, version: 1, stashCount: 1 })
    await store.recheck()
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.getState().pending).toBe(false)
  })
})
