// B3a T4: interactive rebase store (loading, stale responses, submit through the action store).
import { describe, expect, it, vi } from 'vitest'

import type { RebasePlanRequest, RebasePlanValue, RpcResult } from '../../../src/shared/protocol.ts'
import { setAction } from '../../../src/client/rebase/rebase-model.ts'
import type { ActionStore } from '../../../src/client/store/action-store.ts'
import { createRebaseStore } from '../../../src/client/store/rebase-store.ts'

const sha = (letter: string): string => letter.repeat(40)

function plan(letters: string[], extra: Partial<RebasePlanValue> = {}): RebasePlanValue {
  return {
    base: sha('0'),
    head: sha(letters.at(-1) ?? '0'),
    branch: 'main',
    commits: letters.map(letter => ({
      sha: sha(letter),
      shortSha: letter.repeat(7),
      parents: [],
      author: 'A',
      email: 'a@x',
      date: '2020-01-01T00:00:00Z',
      subject: letter,
      message: letter,
      pushed: false,
      branches: [],
    })),
    supportsUpdateRefs: true,
    version: 1,
    ...extra,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function actions(): Pick<ActionStore, 'run'> & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => ({ kind: 'done' as const, value: { head: sha('z'), completed: true } })) }
}

describe('createRebaseStore', () => {
  it('loads the plan into rows, applying a preset', async () => {
    const load = vi.fn(async (): Promise<RpcResult<RebasePlanValue>> => ({ ok: true, value: plan(['a', 'b']) }))
    const store = createRebaseStore({ sessionId: 's', load, actions: actions() })
    await store.open(sha('0'), { kind: 'drop', sha: sha('a') })
    expect(load).toHaveBeenCalledWith({ sessionId: 's', base: sha('0') }, expect.any(AbortSignal))
    const state = store.getState()
    expect(state.status).toBe('ready')
    expect(state.rows.map(row => row.action)).toEqual(['drop', 'pick'])
    expect(state.invalid).toBeNull()
  })

  it('drops a response that arrives after a newer open', async () => {
    const first = deferred<RpcResult<RebasePlanValue>>()
    const second = deferred<RpcResult<RebasePlanValue>>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = createRebaseStore({ sessionId: 's', load, actions: actions() })
    const opening = store.open(sha('1'))
    const reopening = store.open(sha('2'))
    second.resolve({ ok: true, value: plan(['b']) })
    await reopening
    first.resolve({ ok: true, value: plan(['a']) })
    await opening
    expect(store.getState().rows.map(row => row.sha)).toEqual([sha('b')])
    expect(store.getState().base).toBe(sha('2'))
  })

  it('reports a load error and close aborts the request', async () => {
    const pending = deferred<RpcResult<RebasePlanValue>>()
    let signal: AbortSignal | undefined
    const load = vi.fn((_request: RebasePlanRequest, given: AbortSignal) => {
      signal = given
      return pending.promise
    })
    const store = createRebaseStore({ sessionId: 's', load, actions: actions() })
    void store.open(null)
    store.close()
    expect(signal?.aborted).toBe(true)
    const failing = createRebaseStore({
      sessionId: 's',
      load: async () => ({ ok: false, error: { code: 'git/exec-failed', message: 'boom' } }),
      actions: actions(),
    })
    await failing.open(null)
    expect(failing.getState()).toMatchObject({ status: 'error', error: { code: 'git/exec-failed' } })
  })

  it('validates edits and submits the entries once with the plan head', async () => {
    const run = actions()
    const store = createRebaseStore({ sessionId: 's', load: async () => ({ ok: true, value: plan(['a', 'b']) }), actions: run })
    await store.open(sha('0'))
    expect(store.getState().invalid?.key).toBe('rebase.invalid.unchanged')
    store.update(rows => setAction(rows, 1, 'drop'))
    store.setUpdateRefs(true)
    expect(store.getState().invalid).toBeNull()
    const trigger = null
    const submitting = store.submit(trigger)
    const again = store.submit(trigger)
    expect(store.getState().submitting).toBe(true)
    await Promise.all([submitting, again])
    expect(run.run).toHaveBeenCalledTimes(1)
    expect(run.run).toHaveBeenCalledWith(
      'interactiveRebase',
      {
        base: sha('0'),
        head: sha('b'),
        entries: [{ sha: sha('a'), action: 'pick' }, { sha: sha('b'), action: 'drop' }],
        updateRefs: true,
      },
      { smartStash: 'rebase', target: 'interactive-rebase', trigger: null },
    )
    expect(store.getState().submitting).toBe(false)
  })

  it('does not submit an invalid list and never sends updateRefs when unsupported', async () => {
    const run = actions()
    const store = createRebaseStore({
      sessionId: 's',
      load: async () => ({ ok: true, value: plan(['a', 'b'], { supportsUpdateRefs: false }) }),
      actions: run,
    })
    await store.open(sha('0'))
    expect(await store.submit(null)).toBeUndefined()
    expect(run.run).not.toHaveBeenCalled()
    store.update(rows => setAction(rows, 0, 'drop'))
    store.setUpdateRefs(true)
    await store.submit(null)
    expect(run.run.mock.calls[0]?.[1]).toMatchObject({ updateRefs: false })
  })

  it('requires the pushed-history confirmation before submitting', async () => {
    const pushed = plan(['a', 'b'])
    const first = pushed.commits[0]
    if (first !== undefined) first.pushed = true
    const run = actions()
    const store = createRebaseStore({ sessionId: 's', load: async () => ({ ok: true, value: pushed }), actions: run })
    await store.open(sha('0'))
    store.update(rows => setAction(rows, 0, 'reword'))
    expect(store.getState()).toMatchObject({ rewritesPushed: true, invalid: { key: 'rebase.invalid.confirmPushed' } })
    store.setConfirmPushed(true)
    expect(store.getState().invalid).toBeNull()
  })
})
