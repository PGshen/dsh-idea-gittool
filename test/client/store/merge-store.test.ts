// B1 T5 merge store: open (fresh / draft restore / discarded draft), model actions with dirty and
// undo, saveAndClose, apply (+ callback), stale errors, stale-response drop, read-only rejection.
import { describe, expect, it, vi } from 'vitest'
import { toDraft } from '../../../src/client/merge/merge-model.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps } from '../../../src/client/store/merge-store.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'

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

function setup(over: { load?: MergeStoreDeps['loadFile']; run?: MergeStoreDeps['actions']['run']; readOnly?: MergeStoreDeps['readOnlyReason']; autoApply?: boolean } = {}) {
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
    ...(over.autoApply === undefined ? {} : { autoApplyNonConflicting: () => over.autoApply === true }),
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

describe('resolved files (T7 Review Changes, ruling 16)', () => {
  const sidesText = { base: 'one\ntwo\nthree\n', ours: 'one\nOURS\nthree\n', theirs: 'one\nTHEIRS\nthree\n' }
  const resolvedFile = (worktreeText: string | null, over: Partial<MergeFileValue> = {}): MergeFileValue =>
    file({ resolved: true, worktreeText, ...over })

  function setupResolved(value: MergeFileValue) {
    const onLoadFailed = vi.fn()
    const onOpened = vi.fn()
    const store = createMergeStore({
      loadFile: async () => ({ ok: true, value }),
      actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'],
      onLoadFailed,
      onOpened,
    })
    return { store, onLoadFailed, onOpened }
  }

  it('a worktree equal to one side opens with that side taken', async () => {
    const { store, onOpened } = setupResolved(resolvedFile(sidesText.ours))
    await store.open('a.txt')
    expect(store.getState()).toMatchObject({ status: 'ready', dirty: false, draftDiscarded: false })
    expect(store.getState().model?.result).toBe(sidesText.ours)
    expect(store.getState().model?.chunks.every(c => c.state !== 'edited')).toBe(true)
    expect(onOpened).toHaveBeenCalledWith('a.txt')
  })

  it('any other worktree text is the Result with every chunk edited', async () => {
    const { store } = setupResolved(resolvedFile('one\nMINE\nthree\n'))
    await store.open('a.txt')
    expect(store.getState().model?.result).toBe('one\nMINE\nthree\n')
    expect(store.getState().model?.chunks.every(c => c.state === 'edited')).toBe(true)
    expect(store.getState().dirty).toBe(false)
  })

  it('no worktree text, or binary / too large sides: not reviewable, reported to onLoadFailed', async () => {
    for (const value of [
      resolvedFile(null),
      resolvedFile(sidesText.ours, { ours: side(null) }),
      resolvedFile(sidesText.ours, { tooLarge: true, ours: side(null) }),
    ]) {
      const { store, onLoadFailed, onOpened } = setupResolved(value)
      await store.open('a.txt')
      expect(store.getState()).toMatchObject({ status: 'error', model: null, error: text('merge.error.worktreeUnreadable') })
      expect(onLoadFailed).toHaveBeenCalledWith('a.txt', null)
      expect(onOpened).not.toHaveBeenCalled()
    }
  })

  it('ruling 20: a draft of a resolved file is restored even when the worktree differs, with a notice', async () => {
    const fresh = setup()
    await fresh.store.open('a.txt')
    const draft = toDraft(fresh.store.getState().model!, STAGES)
    const differs = setupResolved(resolvedFile(sidesText.ours, { draft }))
    await differs.store.open('a.txt')
    expect(differs.store.getState().model?.result).toBe(draft.result)
    expect(differs.store.getState()).toMatchObject({ draftDiscarded: false, draftDiffers: true, dirty: false })
    const current = setupResolved(resolvedFile(sidesText.base, { draft }))
    await current.store.open('a.txt')
    expect(current.store.getState().model?.chunks.map(c => c.state)).toEqual(draft.chunks.map(c => c.state))
    expect(current.store.getState().draftDiffers).toBe(false)
  })

  it('a stale or unusable draft of a resolved file is reported discarded (no longer silent)', async () => {
    const stale = setupResolved(resolvedFile(sidesText.ours, { draftStale: true }))
    await stale.store.open('a.txt')
    expect(stale.store.getState()).toMatchObject({ draftDiscarded: true, draftDiffers: false })
    expect(stale.store.getState().model?.result).toBe(sidesText.ours)
    const fresh = setup()
    await fresh.store.open('a.txt')
    const broken = { ...toDraft(fresh.store.getState().model!, STAGES), chunks: [] }
    const unusable = setupResolved(resolvedFile(sidesText.ours, { draft: broken }))
    await unusable.store.open('a.txt')
    expect(unusable.store.getState()).toMatchObject({ draftDiscarded: true, draftDiffers: false })
  })

  it('a failed mergeFile is reported with its error', async () => {
    const error = { code: 'git/stale-target' as const, message: 'gone' }
    const onLoadFailed = vi.fn()
    const store = createMergeStore({ loadFile: async () => ({ ok: false, error }), actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'], onLoadFailed })
    await store.open('a.txt')
    expect(onLoadFailed).toHaveBeenCalledWith('a.txt', error)
  })
})

describe('auto-apply non-conflicting changes (B4a)', () => {
  /** Left-only change on line 1, a conflict on line 3, right-only change on line 5. */
  const mixed = (): MergeFileValue => file({
    base: side('a\nb\nc\nd\ne\n', '1'.repeat(40)),
    ours: side('A\nb\nX\nd\ne\n', '2'.repeat(40)),
    theirs: side('a\nb\nY\nd\nE\n', '3'.repeat(40)),
  })

  it('applies them once on open when the setting is on; undo goes back to base', async () => {
    const { store } = setup({ load: async () => ({ ok: true, value: mixed() }), autoApply: true })
    await store.open('a.txt')
    const state = store.getState()
    expect(state.model?.result).toBe('A\nb\nc\nd\nE\n')
    expect(state.model?.chunks.filter(chunk => chunk.kind === 'conflict')).toHaveLength(1)
    expect(state.dirty).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.getState().model?.result).toBe('a\nb\nc\nd\ne\n')
  })

  it('leaves the model alone when off, or when a draft was restored', async () => {
    const off = setup({ load: async () => ({ ok: true, value: mixed() }), autoApply: false })
    await off.store.open('a.txt')
    expect(off.store.getState().model?.result).toBe('a\nb\nc\nd\ne\n')
    expect(off.store.getState().dirty).toBe(false)

    const draft = toDraft(off.store.getState().model!, STAGES)
    const restored = setup({ load: async () => ({ ok: true, value: { ...mixed(), draft } }), autoApply: true })
    await restored.store.open('a.txt')
    expect(restored.store.getState().model?.result).toBe('a\nb\nc\nd\ne\n')
    expect(restored.store.getState().dirty).toBe(false)
  })

  it('does not touch an already resolved file', async () => {
    const { store } = setup({ load: async () => ({ ok: true, value: { ...mixed(), resolved: true, worktreeText: 'a\nb\nX\nd\ne\n' } }), autoApply: true })
    await store.open('a.txt')
    expect(store.getState().dirty).toBe(false)
  })
})
