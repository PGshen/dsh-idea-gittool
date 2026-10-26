// B1 T5 merge store: open (fresh / draft restore / discarded draft), model actions with dirty and
// undo, saveAndClose, apply (+ callback), stale errors, stale-response drop, read-only rejection.
import { describe, expect, it, vi } from 'vitest'
import { toDraft } from '../../../src/client/merge/merge-model.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps } from '../../../src/client/store/merge-store.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { DiffFileValue, MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'
import { gitBlobSha } from '../../../src/client/merge/resolved-replay.ts'

const side = (body: string | null, blob = 'b'.repeat(40)): MergeSide => ({ blob, text: body, binary: body === null, size: body?.length ?? 0 })

function file(over: Partial<MergeFileValue> = {}): MergeFileValue {
  return {
    path: 'a.txt',
    kind: 'both-modified',
    base: side('one\ntwo\nthree\n', '1'.repeat(40)),
    ours: side('one\nOURS\nthree\n', '2'.repeat(40)),
    theirs: side('one\nTHEIRS\nthree\n', '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: 'w'.repeat(40),
    draft: null,
    draftStale: false,
    resolved: false,
    ...over,
  }
}

const STAGES = { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function setup(over: { load?: MergeStoreDeps['loadFile']; run?: MergeStoreDeps['actions']['run']; readOnly?: MergeStoreDeps['readOnlyReason'] } = {}) {
  const loadFile = vi.fn(over.load ?? (async () => ({ ok: true, value: file() }) as RpcResult<MergeFileValue>))
  const run = vi.fn(over.run ?? (async () => ({ kind: 'done', value: { path: 'a.txt', remaining: 2 } }) as ActionOutcome<never>))
  const onApplied = vi.fn()
  const onOpened = vi.fn()
  const store = createMergeStore({
    loadFile,
    actions: { run } as MergeStoreDeps['actions'],
    readOnlyReason: over.readOnly,
    onApplied,
    onOpened,
  })
  return { store, loadFile, run, onApplied, onOpened }
}

describe('open', () => {
  it('loads a fresh model starting from base and reports the opened path', async () => {
    const { store, onOpened } = setup()
    const pending = store.open('a.txt')
    expect(store.getState()).toMatchObject({ status: 'loading', path: 'a.txt' })
    await pending
    const state = store.getState()
    expect(state).toMatchObject({ status: 'ready', dirty: false, draftDiscarded: false, error: null })
    expect(state.model?.result).toBe('one\ntwo\nthree\n')
    expect(onOpened).toHaveBeenCalledWith('a.txt')
  })

  it('restores the draft state and result', async () => {
    const fresh = setup()
    await fresh.store.open('a.txt')
    const model = fresh.store.getState().model!
    const chunk = model.chunks.find(c => c.kind === 'conflict')!
    fresh.store.dispatch({ type: 'accept', id: chunk.id, side: 'left' })
    const draft = toDraft(fresh.store.getState().model!, STAGES)

    const { store } = setup({ load: async () => ({ ok: true, value: file({ draft }) }) })
    await store.open('a.txt')
    expect(store.getState().model?.result).toBe('one\nOURS\nthree\n')
    expect(store.getState().draftDiscarded).toBe(false)
    expect(store.getState().dirty).toBe(false)
  })

  it('an unusable or stale draft starts fresh and flags draftDiscarded', async () => {
    const fresh = setup()
    await fresh.store.open('a.txt')
    const draft = toDraft(fresh.store.getState().model!, STAGES)
    const broken = { ...draft, chunks: [] }
    const unusable = setup({ load: async () => ({ ok: true, value: file({ draft: broken }) }) })
    await unusable.store.open('a.txt')
    expect(unusable.store.getState()).toMatchObject({ draftDiscarded: true, status: 'ready' })
    expect(unusable.store.getState().model?.result).toBe('one\ntwo\nthree\n')

    const stale = setup({ load: async () => ({ ok: true, value: file({ draftStale: true }) }) })
    await stale.store.open('a.txt')
    expect(stale.store.getState().draftDiscarded).toBe(true)
  })

  it('binary, too large and delete-kind files load without a model', async () => {
    for (const value of [
      file({ ours: side(null) }),
      file({ tooLarge: true, ours: side(null) }),
      file({ kind: 'deleted-by-them', theirs: null }),
    ]) {
      const { store } = setup({ load: async () => ({ ok: true, value }) })
      await store.open('a.txt')
      expect(store.getState()).toMatchObject({ status: 'ready', model: null })
      expect(store.getState().file).toBe(value)
    }
  })

  it('a load failure becomes the error state', async () => {
    const { store } = setup({ load: async () => ({ ok: false, error: { code: 'git/exec-failed', message: 'x' } }) })
    await store.open('a.txt')
    expect(store.getState()).toMatchObject({ status: 'error', error: text('merge.error.loadFailed', { code: 'git/exec-failed' }) })
  })

  it('drops the response of an older open when another file was opened meanwhile', async () => {
    const first = deferred<RpcResult<MergeFileValue>>()
    const load = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({ ok: true, value: file({ path: 'b.txt' }) }))
    const { store, onOpened } = setup({ load })
    const older = store.open('a.txt')
    await store.open('b.txt')
    first.resolve({ ok: true, value: file({ path: 'a.txt' }) })
    await older
    expect(store.getState().path).toBe('b.txt')
    expect(store.getState().file?.path).toBe('b.txt')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })
})

describe('dispatch / edit / undo', () => {
  async function ready() {
    const ctx = setup()
    await ctx.store.open('a.txt')
    const id = ctx.store.getState().model!.chunks.find(c => c.kind === 'conflict')!.id
    return { ...ctx, id }
  }

  it('actions update the model and set dirty; undo and redo walk the history', async () => {
    const { store, id } = await ready()
    store.dispatch({ type: 'accept', id, side: 'left' })
    expect(store.getState()).toMatchObject({ dirty: true })
    expect(store.getState().model?.result).toBe('one\nOURS\nthree\n')
    store.dispatch({ type: 'accept', id, side: 'right' })
    expect(store.getState().model?.result).toBe('one\nOURS\nTHEIRS\nthree\n')
    expect(store.undo()).toBe(true)
    expect(store.getState().model?.result).toBe('one\nOURS\nthree\n')
    expect(store.undo()).toBe(true)
    expect(store.getState()).toMatchObject({ dirty: false })
    expect(store.undo()).toBe(false)
    expect(store.redo()).toBe(true)
    expect(store.getState().model?.result).toBe('one\nOURS\nthree\n')
    expect(store.getState().dirty).toBe(true)
  })

  it('an action that changes nothing leaves dirty alone; resolveSimple returns the count', async () => {
    const { store } = await ready()
    store.dispatch({ type: 'applyNonConflicting', which: 'all' })
    expect(store.getState().dirty).toBe(false)
    expect(store.dispatch({ type: 'resolveSimple' })).toBe(0)
  })

  it('edit maps a user edit into the model, marks dirty and coalesces undo steps', async () => {
    const { store, id } = await ready()
    store.edit(4, 7, 'X')
    store.edit(5, 5, 'Y')
    expect(store.getState().dirty).toBe(true)
    expect(store.getState().model?.chunks.find(c => c.id === id)?.state).toBe('edited')
    expect(store.undo()).toBe(true)
    expect(store.getState().model?.result).toBe('one\ntwo\nthree\n')
    expect(store.getState().dirty).toBe(false)
  })

  it('does nothing without a model', async () => {
    const { store } = setup({ load: async () => ({ ok: true, value: file({ ours: side(null) }) }) })
    await store.open('a.txt')
    expect(store.dispatch({ type: 'revert' })).toBe(0)
    store.edit(0, 0, 'x')
    expect(store.getState().dirty).toBe(false)
  })
})

describe('saveAndClose', () => {
  it('writes the draft with the loaded stages through the action store and clears dirty', async () => {
    const { store, run } = setup()
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    const pending = store.saveAndClose()
    expect(store.getState().status).toBe('saving')
    expect(await pending).toBe(true)
    expect(run).toHaveBeenCalledWith('mergeDraftSave', expect.objectContaining({
      path: 'a.txt',
      draft: expect.objectContaining({ version: 1, stages: STAGES, result: 'one\nOURS\nthree\n' }),
    }), expect.anything())
    expect(store.getState()).toMatchObject({ status: 'ready', dirty: false, error: null })
  })

  it('a clean window closes without a request', async () => {
    const { store, run } = setup()
    await store.open('a.txt')
    expect(await store.saveAndClose()).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('a stale-target failure keeps dirty and shows the reload text', async () => {
    const { store } = setup({
      run: async () => ({
        kind: 'failed',
        error: { code: 'git/stale-target', message: 's', details: { target: 'conflict', reason: 'stages-changed' } },
        message: text('action.error.git/stale-target.conflict'),
      }),
    })
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    expect(await store.saveAndClose()).toBe(false)
    expect(store.getState()).toMatchObject({ status: 'ready', dirty: true, error: text('merge.error.stale') })
  })

  it('other failures use the action store message', async () => {
    const message = text('action.error.fallback', { code: 'git/exec-failed', message: 'm' })
    const { store } = setup({ run: async () => ({ kind: 'failed', error: { code: 'git/exec-failed', message: 'm' }, message }) })
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    expect(await store.saveAndClose()).toBe(false)
    expect(store.getState().error).toEqual(message)
  })
})

describe('apply', () => {
  it('sends the result with stages and expectedWorktreeSha, then notifies onApplied', async () => {
    const { store, run, onApplied } = setup()
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'right' })
    const outcome = await store.apply()
    expect(outcome).toEqual({ remaining: 2 })
    expect(run).toHaveBeenCalledWith('mergeApply', {
      path: 'a.txt',
      result: 'one\nTHEIRS\nthree\n',
      stages: STAGES,
      expectedWorktreeSha: 'w'.repeat(40),
    }, expect.anything())
    expect(onApplied).toHaveBeenCalledWith('a.txt', 2)
    expect(store.getState()).toMatchObject({ status: 'ready', dirty: false })
  })

  it('stale-target does not call onApplied and keeps the result', async () => {
    const { store, onApplied } = setup({
      run: async () => ({
        kind: 'failed',
        error: { code: 'git/stale-target', message: 's', details: { target: 'conflict', reason: 'worktree-changed' } },
        message: text('action.error.git/stale-target.conflict'),
      }),
    })
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'right' })
    expect(await store.apply()).toBeNull()
    expect(onApplied).not.toHaveBeenCalled()
    expect(store.getState()).toMatchObject({ dirty: true, error: text('merge.error.stale') })
  })

  it('is not available without a model', async () => {
    const { store, run } = setup({ load: async () => ({ ok: true, value: file({ tooLarge: true, ours: side(null) }) }) })
    await store.open('a.txt')
    expect(await store.apply()).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('read-only mode', () => {
  it('rejects save and apply locally with the policy reason', async () => {
    const reason = text('readOnly.title')
    const { store, run } = setup({ readOnly: () => reason })
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    expect(await store.saveAndClose()).toBe(false)
    expect(store.getState().error).toEqual(reason)
    expect(await store.apply()).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(store.getState().dirty).toBe(true)
  })
})

describe('discard / unresolve', () => {
  it('discard returns to idle without a request', async () => {
    const { store, run } = setup()
    await store.open('a.txt')
    store.dispatch({ type: 'acceptFile', side: 'left' })
    store.discard()
    expect(store.getState()).toMatchObject({ status: 'idle', path: null, file: null, model: null, dirty: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('discard while loading drops the late response', async () => {
    const slow = deferred<RpcResult<MergeFileValue>>()
    const { store } = setup({ load: () => slow.promise })
    const pending = store.open('a.txt')
    store.discard()
    slow.resolve({ ok: true, value: file() })
    await pending
    expect(store.getState().status).toBe('idle')
  })

  it('unresolve goes through the action store and reports remaining', async () => {
    const { store, run } = setup({ run: async () => ({ kind: 'done', value: { path: 'a.txt', remaining: 3 } }) as ActionOutcome<never> })
    const outcome = await store.unresolve('a.txt')
    expect(outcome).toEqual({ remaining: 3 })
    expect(run).toHaveBeenCalledWith('unresolveConflict', { path: 'a.txt' }, expect.anything())
  })
})

describe('resolved files (T7 Review Changes)', () => {
  const sidesText = { base: 'one\ntwo\nthree\n', ours: 'one\nOURS\nthree\n', theirs: 'one\nTHEIRS\nthree\n' }
  const resolvedFile = (worktree: string, over: Partial<MergeFileValue> = {}): MergeFileValue =>
    file({ resolved: true, worktreeSha: gitBlobSha(worktree), ...over })
  const noDiff = (over: Partial<DiffFileValue> = {}): DiffFileValue => ({ oldPath: 'a.txt', newPath: 'a.txt', status: 'M', binary: false, hunks: [], truncated: false, ...over })

  function setupResolved(value: MergeFileValue, diffs?: { staged: DiffFileValue; worktree: DiffFileValue }) {
    const loadDiff = vi.fn(async (_path: string, scope: 'staged' | 'worktree') => (
      diffs === undefined ? { ok: false, error: { code: 'git/exec-failed', message: 'x' } } : { ok: true, value: diffs[scope] }
    ) as RpcResult<DiffFileValue>)
    const onLoadFailed = vi.fn()
    const store = createMergeStore({
      loadFile: async () => ({ ok: true, value }),
      loadDiff,
      actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'],
      onLoadFailed,
    })
    return { store, loadDiff, onLoadFailed }
  }

  it('a worktree equal to one side opens with that side taken (no diff needed)', async () => {
    const { store, loadDiff } = setupResolved(resolvedFile(sidesText.ours))
    await store.open('a.txt')
    expect(store.getState()).toMatchObject({ status: 'ready', dirty: false })
    expect(store.getState().model?.result).toBe(sidesText.ours)
    expect(store.getState().model?.chunks.every(c => c.state !== 'edited')).toBe(true)
    expect(loadDiff).not.toHaveBeenCalled()
  })

  it('a worktree the replay cannot explain is rebuilt from the diffs, every chunk edited', async () => {
    const worktree = 'one\nMINE\nthree\n'
    const hunk = {
      header: '@@ -2 +2 @@', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
      lines: [{ type: 'del' as const, text: 'OURS' }, { type: 'add' as const, text: 'MINE' }],
    }
    const { store, loadDiff } = setupResolved(resolvedFile(worktree), { staged: noDiff({ hunks: [hunk] }), worktree: noDiff() })
    await store.open('a.txt')
    expect(loadDiff).toHaveBeenCalledWith('a.txt', 'staged')
    expect(store.getState().model?.result).toBe(worktree)
    expect(store.getState().model?.chunks.every(c => c.state === 'edited')).toBe(true)
    expect(store.getState().dirty).toBe(false)
  })

  it('a worktree that cannot be rebuilt is a load error reported to onLoadFailed', async () => {
    const { store, onLoadFailed } = setupResolved(resolvedFile('?\n'), { staged: noDiff({ truncated: true }), worktree: noDiff() })
    await store.open('a.txt')
    expect(store.getState()).toMatchObject({ status: 'error', model: null, error: text('merge.error.worktreeUnreadable') })
    expect(onLoadFailed).toHaveBeenCalledWith('a.txt', null)
  })

  it('a draft of a resolved file is used only when its Result is the worktree', async () => {
    const fresh = setup()
    await fresh.store.open('a.txt')
    const draft = toDraft(fresh.store.getState().model!, STAGES)
    // The draft Result (base) is not the worktree (ours): the replay wins and the draft is not reported discarded.
    const stale = setupResolved(resolvedFile(sidesText.ours, { draft }))
    await stale.store.open('a.txt')
    expect(stale.store.getState().model?.result).toBe(sidesText.ours)
    expect(stale.store.getState().draftDiscarded).toBe(false)
    const current = setupResolved(resolvedFile(sidesText.base, { draft }))
    await current.store.open('a.txt')
    expect(current.store.getState().model?.chunks.map(c => c.state)).toEqual(draft.chunks.map(c => c.state))
  })

  it('a failed mergeFile is reported with its error', async () => {
    const error = { code: 'git/stale-target' as const, message: 'gone' }
    const onLoadFailed = vi.fn()
    const store = createMergeStore({ loadFile: async () => ({ ok: false, error }), actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'], onLoadFailed })
    await store.open('a.txt')
    expect(onLoadFailed).toHaveBeenCalledWith('a.txt', error)
  })
})
