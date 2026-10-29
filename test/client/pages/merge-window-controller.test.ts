// B1 T6 merge window behaviour without a DOM: keyboard map, F7 / Shift+F7 navigation (end of file →
// next file), Esc / back with the save / discard / cancel question, Cmd/Ctrl+S, apply with the
// "still N unresolved" confirmation and never twice, resolveSimple notice, file after apply.
import { describe, expect, it, vi } from 'vitest'
import { adjacentPath, createMergeWindowController, createReviewRunner, focusIsLost, isStrayEscape, mergeKeyCommand, nextFileAfterApply, shouldRefocusAfterWrite } from '../../../src/client/pages/merge-window-controller.ts'
import type { MergeWindowControllerDeps } from '../../../src/client/pages/merge-window-controller.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps } from '../../../src/client/store/merge-store.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import type { MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'

const key = (k: string, mods: { shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean } = {}) => ({
  key: k,
  shiftKey: mods.shift === true,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  altKey: mods.alt === true,
})

describe('mergeKeyCommand', () => {
  it('maps the window keys', () => {
    expect(mergeKeyCommand(key('F7'))).toBe('nextChunk')
    expect(mergeKeyCommand(key('F7', { shift: true }))).toBe('prevChunk')
    expect(mergeKeyCommand(key('Escape'))).toBe('back')
    expect(mergeKeyCommand(key('z', { meta: true }))).toBe('undo')
    expect(mergeKeyCommand(key('z', { ctrl: true }))).toBe('undo')
    expect(mergeKeyCommand(key('Z', { meta: true, shift: true }))).toBe('redo')
    expect(mergeKeyCommand(key('z', { ctrl: true, shift: true }))).toBe('redo')
    expect(mergeKeyCommand(key('y', { ctrl: true }))).toBe('redo')
    expect(mergeKeyCommand(key('s', { meta: true }))).toBe('save')
    expect(mergeKeyCommand(key('S', { ctrl: true }))).toBe('save')
  })

  it('leaves every other key alone', () => {
    expect(mergeKeyCommand(key('z'))).toBeNull()
    expect(mergeKeyCommand(key('s'))).toBeNull()
    expect(mergeKeyCommand(key('F7', { meta: true }))).toBeNull()
    expect(mergeKeyCommand(key('z', { meta: true, alt: true }))).toBeNull()
    expect(mergeKeyCommand(key('Enter'))).toBeNull()
  })
})

const side = (body: string | null, blob: string): MergeSide => ({ blob, text: body, binary: body === null, size: body?.length ?? 0 })

/** Two chunks: 0 left-only, 1 right-only (both unresolved at first). */
function twoChunks(): MergeFileValue {
  return {
    path: 'a.txt',
    kind: 'both-modified',
    base: side('a\nb\nc\n', '1'.repeat(40)),
    ours: side('a\nX\nY\nb\nc\n', '2'.repeat(40)),
    theirs: side('a\nb\nc\nZ\n', '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: 'w'.repeat(40),
    draft: null,
    draftStale: false,
    resolved: false,
  }
}

async function setup(over: {
  value?: MergeFileValue
  run?: MergeStoreDeps['actions']['run']
  adjacent?: Partial<Record<'next' | 'prev', string>>
} = {}) {
  const run = vi.fn(over.run ?? (async () => ({ kind: 'done', value: { path: 'a.txt', remaining: 1 } }) as ActionOutcome<never>))
  const onApplied = vi.fn()
  const store = createMergeStore({
    loadFile: async () => ({ ok: true, value: over.value ?? twoChunks() }) as RpcResult<MergeFileValue>,
    actions: { run } as MergeStoreDeps['actions'],
    onApplied,
  })
  await store.open('a.txt')
  const deps = {
    store,
    adjacentFile: vi.fn((dir: 'next' | 'prev') => over.adjacent?.[dir] ?? null),
    onClose: vi.fn(),
    onOpenFile: vi.fn(),
  } satisfies MergeWindowControllerDeps
  const controller = createMergeWindowController(deps)
  const reveal = vi.fn()
  controller.setReveal(reveal)
  return { run, onApplied, controller, reveal, ...deps }
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('F7 navigation', () => {
  it('walks unresolved chunks and reveals each one', async () => {
    const { controller, reveal } = await setup()
    controller.command('nextChunk')
    expect(controller.getState().currentChunk).toBe(0)
    expect(reveal).toHaveBeenLastCalledWith(0)
    controller.command('nextChunk')
    expect(controller.getState().currentChunk).toBe(1)
    controller.command('prevChunk')
    expect(controller.getState().currentChunk).toBe(0)
  })

  it('skips resolved chunks', async () => {
    const { controller, reveal } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('nextChunk')
    expect(reveal).toHaveBeenLastCalledWith(1)
  })

  it('at the end: says so; F7 again opens the next file', async () => {
    const { controller, onOpenFile } = await setup({ adjacent: { next: 'b.txt' } })
    controller.command('nextChunk')
    controller.command('nextChunk')
    controller.command('nextChunk')
    expect(controller.getState().atEnd).toBe('next')
    expect(controller.getState().notice?.key).toBe('merge.nav.endNext')
    expect(onOpenFile).not.toHaveBeenCalled()
    controller.command('nextChunk')
    expect(onOpenFile).toHaveBeenCalledWith('b.txt')
  })

  it('at the end without another file: only the notice', async () => {
    const { controller, onOpenFile } = await setup()
    controller.command('prevChunk')
    controller.command('prevChunk')
    controller.command('prevChunk')
    expect(controller.getState().notice?.key).toBe('merge.nav.endNone')
    controller.command('prevChunk')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('moving to the next file with unsaved changes asks first', async () => {
    const { controller, onOpenFile } = await setup({ adjacent: { next: 'b.txt' } })
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.requestLeave({ kind: 'file', path: 'b.txt' })
    expect(controller.getState().confirm).toEqual({ kind: 'leave', target: { kind: 'file', path: 'b.txt' } })
    controller.answerLeave('discard')
    expect(onOpenFile).toHaveBeenCalledWith('b.txt')
  })
})

describe('Esc / back', () => {
  it('without changes closes right away', async () => {
    const { controller, onClose, store } = await setup()
    controller.command('back')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(store.getState().status).toBe('idle')
  })

  it('with unsaved changes asks save / discard / cancel', async () => {
    const { controller, onClose, run } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('back')
    expect(controller.getState().confirm).toEqual({ kind: 'leave', target: { kind: 'close' } })
    expect(onClose).not.toHaveBeenCalled()

    controller.answerLeave('cancel')
    expect(controller.getState().confirm).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // Esc while the question is open only closes the question.
    controller.command('back')
    controller.command('back')
    expect(controller.getState().confirm).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    controller.command('back')
    controller.answerLeave('save')
    await flush()
    expect(run).toHaveBeenCalledWith('mergeDraftSave', expect.objectContaining({ path: 'a.txt' }), { target: 'a.txt' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('discard closes without saving', async () => {
    const { controller, onClose, run } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('back')
    controller.answerLeave('discard')
    expect(run).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a failed save keeps the window open', async () => {
    const { controller, onClose } = await setup({
      run: async () => ({ kind: 'failed', error: { code: 'git/exec-failed', message: 'x' }, message: { key: 'write.error.fallback' } }) as ActionOutcome<never>,
    })
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('back')
    controller.answerLeave('save')
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(controller.getState().confirm).toBeNull()
  })
})

describe('save, undo, resolveSimple', () => {
  it('Cmd/Ctrl+S saves the draft and stays', async () => {
    const { controller, onClose, run, store } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('save')
    await flush()
    expect(run).toHaveBeenCalledWith('mergeDraftSave', expect.anything(), { target: 'a.txt' })
    expect(store.getState().dirty).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(controller.getState().notice?.key).toBe('merge.saved')
  })

  it('undo / redo commands use the store history', async () => {
    const { controller, store } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.command('undo')
    expect(store.getState().model!.chunks[0]!.state).toBe('pending')
    controller.command('redo')
    expect(store.getState().model!.chunks[0]!.state).toBe('left')
  })

  it('resolveSimple reports how many chunks it resolved', async () => {
    const { controller } = await setup({
      value: { ...twoChunks(), base: side('a b c\n', '1'.repeat(40)), ours: side('A b c\n', '2'.repeat(40)), theirs: side('a b C\n', '3'.repeat(40)) },
    })
    controller.run({ type: 'resolveSimple' })
    expect(controller.getState().notice).toEqual({ key: 'merge.simple.done', params: { count: 1 } })
    controller.run({ type: 'resolveSimple' })
    expect(controller.getState().notice).toEqual({ key: 'merge.simple.none' })
  })
})

describe('apply', () => {
  it('asks when chunks are still unresolved, then applies once', async () => {
    const { controller, run, onApplied } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.requestApply()
    expect(controller.getState().confirm).toEqual({ kind: 'apply', unresolved: 1, overwrite: false, nonConflicting: true })
    expect(run).not.toHaveBeenCalled()
    controller.confirmApply()
    await flush()
    expect(run).toHaveBeenCalledWith('mergeApply', expect.objectContaining({ path: 'a.txt', result: 'a\nX\nY\nb\nc\n' }), { target: 'a.txt' })
    expect(onApplied).toHaveBeenCalledWith('a.txt', 1)
    expect(controller.getState().applied).toBe(true)
    controller.requestApply()
    controller.confirmApply()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('applies directly when everything is resolved', async () => {
    const { controller, run } = await setup()
    controller.run({ type: 'applyNonConflicting', which: 'all' })
    controller.requestApply()
    expect(controller.getState().confirm).toBeNull()
    await flush()
    expect(run).toHaveBeenCalledWith('mergeApply', expect.objectContaining({ result: 'a\nX\nY\nb\nc\nZ\n' }), { target: 'a.txt' })
  })

  it('ruling 19: a worktree edited without markers asks before overwriting, even when all is resolved', async () => {
    const { controller, run } = await setup({ value: { ...twoChunks(), worktreeHasMarkers: false } })
    controller.run({ type: 'applyNonConflicting', which: 'all' })
    controller.requestApply()
    expect(controller.getState().confirm).toEqual({ kind: 'apply', unresolved: 0, overwrite: true, nonConflicting: false })
    expect(run).not.toHaveBeenCalled()
    controller.confirmApply()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('markers still in the worktree (or unknown): no overwrite question', async () => {
    for (const worktreeHasMarkers of [true, undefined]) {
      const value = { ...twoChunks(), ...(worktreeHasMarkers === undefined ? {} : { worktreeHasMarkers }) }
      const { controller, run } = await setup({ value })
      controller.run({ type: 'applyNonConflicting', which: 'all' })
      controller.requestApply()
      expect(controller.getState().confirm).toBeNull()
      await flush()
      expect(run).toHaveBeenCalledTimes(1)
    }
  })

  it('ruling 21: 先应用非冲突更改 in the question applies them, then applies when nothing is left', async () => {
    const { controller, run } = await setup()
    controller.requestApply()
    expect(controller.getState().confirm).toEqual({ kind: 'apply', unresolved: 2, overwrite: false, nonConflicting: true })
    controller.applyNonConflictingFirst()
    await flush()
    expect(run).toHaveBeenCalledWith('mergeApply', expect.objectContaining({ result: 'a\nX\nY\nb\nc\nZ\n' }), { target: 'a.txt' })
  })

  it('ruling 21: after 先应用非冲突更改 the question stays for what is left (conflicts, overwrite)', async () => {
    const { controller, run, store } = await setup({ value: { ...twoChunks(), worktreeHasMarkers: false } })
    controller.requestApply()
    controller.applyNonConflictingFirst()
    expect(store.getState().model?.result).toBe('a\nX\nY\nb\nc\nZ\n')
    expect(controller.getState().confirm).toEqual({ kind: 'apply', unresolved: 0, overwrite: true, nonConflicting: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('a failed apply can be retried', async () => {
    const failed = { kind: 'failed', error: { code: 'git/stale-target', message: 'x', details: { reason: 'worktree-changed' } }, message: { key: 'write.error.fallback' } }
    const { controller, run, store } = await setup({ run: async () => failed as ActionOutcome<never> })
    controller.run({ type: 'applyNonConflicting', which: 'all' })
    controller.requestApply()
    await flush()
    expect(controller.getState().applied).toBe(false)
    expect(store.getState().error).toEqual({ key: 'merge.error.stale' })
    controller.requestApply()
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('nextFileAfterApply', () => {
  it('opens the next unresolved file after the applied one, wrapping; none when nothing remains', () => {
    expect(nextFileAfterApply(['a', 'b', 'c'], 'b', 2)).toBe('c')
    expect(nextFileAfterApply(['a', 'b', 'c'], 'c', 2)).toBe('a')
    expect(nextFileAfterApply(['a', 'b'], 'b', 0)).toBeNull()
    expect(nextFileAfterApply(['b'], 'b', 1)).toBeNull()
    expect(nextFileAfterApply(['a', 'c'], 'b', 2)).toBe('a')
  })
})

describe('adjacentPath', () => {
  it('previous / next in list order; from outside the list it enters at the ends', () => {
    expect(adjacentPath(['a', 'b', 'c'], 'b', 'next')).toBe('c')
    expect(adjacentPath(['a', 'b', 'c'], 'b', 'prev')).toBe('a')
    expect(adjacentPath(['a', 'b', 'c'], 'c', 'next')).toBeNull()
    expect(adjacentPath(['a', 'b', 'c'], 'a', 'prev')).toBeNull()
    expect(adjacentPath(['a', 'b'], 'z', 'next')).toBe('a')
    expect(adjacentPath(['a', 'b'], 'z', 'prev')).toBe('b')
    expect(adjacentPath([], 'z', 'next')).toBeNull()
  })
})

describe('T7: another entry point replacing a dirty window', () => {
  it('asks first; save / discard then run the outside navigation, cancel keeps the window', async () => {
    const { controller, store, run } = await setup()
    const go = vi.fn()
    expect(controller.guardLeave(go)).toBe(false)
    controller.run({ type: 'accept', id: 0, side: 'left' })
    expect(controller.guardLeave(go)).toBe(true)
    expect(controller.getState().confirm).toEqual({ kind: 'leave', target: { kind: 'external', go } })
    controller.answerLeave('cancel')
    expect(go).not.toHaveBeenCalled()

    controller.guardLeave(go)
    controller.answerLeave('discard')
    expect(go).toHaveBeenCalledTimes(1)
    // Leaving drops the window state, so the outside navigation is not asked about again.
    expect(store.getState().dirty).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('leaving for another file drops the state before the next file opens', async () => {
    const { controller, store, onOpenFile } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    controller.requestLeave({ kind: 'file', path: 'b.txt' })
    controller.answerLeave('discard')
    expect(onOpenFile).toHaveBeenCalledWith('b.txt')
    expect(store.getState().dirty).toBe(false)
  })
})

describe('T7 Review Changes runner (ruling 12)', () => {
  it('opens the queue one by one after each apply and ends back at the list', () => {
    const runner = createReviewRunner()
    expect(runner.next('x')).toBeUndefined()
    expect(runner.start(['a', 'b', 'c'])).toBe('a')
    expect(runner.active()).toBe(true)
    expect(runner.next('a')).toBe('b')
    expect(runner.next('b')).toBe('c')
    expect(runner.next('c')).toBeNull()
    expect(runner.active()).toBe(false)
    expect(runner.next('c')).toBeUndefined()
  })

  it('cancel (back without applying) stops opening further files', () => {
    const runner = createReviewRunner()
    runner.start(['a', 'b'])
    runner.cancel()
    expect(runner.active()).toBe(false)
    expect(runner.next('a')).toBeUndefined()
  })

  it('a file that cannot be opened is skipped: the current one is reported and the next is returned', () => {
    const runner = createReviewRunner()
    runner.start(['a', 'b'])
    expect(runner.current()).toBe('a')
    expect(runner.next('a')).toBe('b')
    expect(runner.current()).toBe('b')
    expect(runner.start([])).toBeNull()
  })
})

describe('T7 fix 6: a held prompt of a pending action (dirty-worktree ask) is cancelled with the question', () => {
  it('cancel / Esc / a newer outside navigation run the held cancel; save or discard do not', async () => {
    const { controller } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    const go = vi.fn()
    const cancel = vi.fn()
    controller.guardLeave(go, cancel)
    controller.answerLeave('cancel')
    expect(cancel).toHaveBeenCalledTimes(1)

    controller.guardLeave(go, cancel)
    controller.command('back')
    expect(controller.getState().confirm).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(2)

    controller.guardLeave(go, cancel)
    controller.guardLeave(vi.fn())
    expect(cancel).toHaveBeenCalledTimes(3)

    controller.guardLeave(go, cancel)
    controller.answerLeave('discard')
    expect(cancel).toHaveBeenCalledTimes(3)
    expect(go).toHaveBeenCalledTimes(1)
  })
})

describe('B1 acceptance demo: Esc with focus on <body>, focus after a failed write', () => {
  const body = { name: 'body' }
  const html = { name: 'html' }
  const inside = { name: 'inside' }
  const elsewhere = { name: 'elsewhere' }
  const root = { contains: (node: unknown) => node === inside }
  const doc = (modals: unknown[] = []) => ({ body, documentElement: html, querySelectorAll: (_selector: string) => modals })
  const esc = (target: unknown, over: Partial<{ defaultPrevented: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
    ...key('Escape'), target, defaultPrevented: false, ...over,
  })

  it('an Esc that reached the page itself (focus fell to <body>) is the window\'s', () => {
    expect(isStrayEscape(esc(body), doc(), root)).toBe(true)
    expect(isStrayEscape(esc(html), doc(), root)).toBe(true)
    expect(isStrayEscape(esc(null), doc(), root)).toBe(true)
  })

  it('leaves Esc alone when something else owns it', () => {
    // Focused element inside or outside the window: its own handlers (and the window's onKeyDown) decide.
    expect(isStrayEscape(esc(inside), doc(), root)).toBe(false)
    expect(isStrayEscape(esc(elsewhere), doc(), root)).toBe(false)
    // Already handled (menu, confirm, host dialog).
    expect(isStrayEscape(esc(body, { defaultPrevented: true }), doc(), root)).toBe(false)
    // Another modal (a sheet, a host dialog) is open outside the window.
    expect(isStrayEscape(esc(body), doc([elsewhere]), root)).toBe(false)
    // A modal inside the window does not count as foreign.
    expect(isStrayEscape(esc(body), doc([inside]), root)).toBe(true)
    // Not a plain Esc, or no window mounted.
    expect(isStrayEscape(esc(body, { shiftKey: true }), doc(), root)).toBe(false)
    expect(isStrayEscape(esc(body, { metaKey: true }), doc(), root)).toBe(false)
    expect(isStrayEscape({ ...key('F7'), target: body, defaultPrevented: false }, doc(), root)).toBe(false)
    expect(isStrayEscape(esc(body), doc(), null)).toBe(false)
  })

  it('refocuses only when a save / apply ends in an error', () => {
    expect(shouldRefocusAfterWrite('applying', 'ready', true)).toBe(true)
    expect(shouldRefocusAfterWrite('saving', 'ready', true)).toBe(true)
    expect(shouldRefocusAfterWrite('applying', 'ready', false)).toBe(false)
    expect(shouldRefocusAfterWrite('ready', 'ready', true)).toBe(false)
    expect(shouldRefocusAfterWrite('loading', 'ready', true)).toBe(false)
  })

  it('focus is lost when it is on <body> or nowhere; focus the user moved elsewhere is kept', () => {
    expect(focusIsLost(body, doc())).toBe(true)
    expect(focusIsLost(html, doc())).toBe(true)
    expect(focusIsLost(null, doc())).toBe(true)
    expect(focusIsLost(elsewhere, doc())).toBe(false)
    expect(focusIsLost(inside, doc())).toBe(false)
  })
})

describe('T2: a held outside prompt survives a failed save and is cancelled when the window goes away', () => {
  const failedSave = async () => ({ kind: 'failed', error: { code: 'git/exec-failed', message: 'x' }, message: { key: 'write.error.fallback' } }) as ActionOutcome<never>

  it('a failed save asks the same question again; it can then be answered', async () => {
    const { controller } = await setup({ run: failedSave })
    controller.run({ type: 'accept', id: 0, side: 'left' })
    const go = vi.fn()
    const cancel = vi.fn()
    controller.guardLeave(go, cancel)
    controller.answerLeave('save')
    expect(controller.getState().confirm).toBeNull()
    await flush()
    expect(controller.getState().confirm).toEqual({ kind: 'leave', target: { kind: 'external', go, cancel } })
    expect(go).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    controller.answerLeave('cancel')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('dispose answers a held prompt as cancelled', async () => {
    const { controller } = await setup()
    controller.run({ type: 'accept', id: 0, side: 'left' })
    const go = vi.fn()
    const cancel = vi.fn()
    controller.guardLeave(go, cancel)
    controller.dispose()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(controller.getState().confirm).toBeNull()
    controller.dispose()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(go).not.toHaveBeenCalled()
  })

  it('dispose during the save cancels the prompt; the late save result does not run it', async () => {
    let finish: (outcome: ActionOutcome<never>) => void = () => {}
    const { controller } = await setup({ run: () => new Promise<ActionOutcome<never>>((resolve) => { finish = resolve }) })
    controller.run({ type: 'accept', id: 0, side: 'left' })
    const go = vi.fn()
    const cancel = vi.fn()
    controller.guardLeave(go, cancel)
    controller.answerLeave('save')
    controller.dispose()
    expect(cancel).toHaveBeenCalledTimes(1)
    finish({ kind: 'done', value: { path: 'a.txt' } } as unknown as ActionOutcome<never>)
    await flush()
    expect(go).not.toHaveBeenCalled()
    expect(controller.getState().confirm).toBeNull()
  })

  it('an outside navigation while a save is running is cancelled, not left hanging (review M5)', async () => {
    let finish: (outcome: ActionOutcome<never>) => void = () => {}
    const { controller } = await setup({ run: () => new Promise<ActionOutcome<never>>((resolve) => { finish = resolve }) })
    controller.run({ type: 'accept', id: 0, side: 'left' })
    const go = vi.fn()
    controller.guardLeave(go, vi.fn())
    controller.answerLeave('save')
    const laterGo = vi.fn()
    const laterCancel = vi.fn()
    expect(controller.guardLeave(laterGo, laterCancel)).toBe(true)
    expect(laterCancel).toHaveBeenCalledTimes(1)
    expect(controller.getState().confirm).toBeNull()
    finish({ kind: 'done', value: { path: 'a.txt' } } as unknown as ActionOutcome<never>)
    await flush()
    expect(go).toHaveBeenCalledTimes(1)
    expect(laterGo).not.toHaveBeenCalled()
  })

  it('dispose without a held prompt does nothing', async () => {
    const { controller, onClose } = await setup()
    controller.dispose()
    expect(onClose).not.toHaveBeenCalled()
  })
})
