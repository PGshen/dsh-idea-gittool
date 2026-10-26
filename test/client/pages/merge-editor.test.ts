// B1 T6 CodeMirror adapter of the merge window, tested without a DOM (EditorState only):
// - user edits of the Result become store.edit calls; model-driven syncs carry an annotation and are
//   never fed back (controller ruling 11),
// - chunk colouring per pane, gutter buttons (accept / ignore, Ctrl/Cmd = resolve the whole chunk),
// - the line mapping that drives synchronized scrolling.
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { applyEdit, createModel, resolveWhole } from '../../../src/client/merge/merge-model.ts'
import {
  MODEL_CHANGE,
  chunkMarks,
  createScrollLock,
  docSyncChange,
  gutterAction,
  gutterActions,
  lineClasses,
  mapLine,
  syncSpec,
  userEdits,
} from '../../../src/client/pages/merge-editor.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps } from '../../../src/client/store/merge-store.ts'
import type { MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'

const CONFLICT = { base: 'one\ntwo\nthree\n', ours: 'one\nOURS\nthree\n', theirs: 'one\nTHEIRS\nthree\n' }
/** chunk 0: left-only insertion of X,Y after `a`; chunk 1: right-only Z appended at the end. */
const ONE_SIDED = { base: 'a\nb\nc\n', ours: 'a\nX\nY\nb\nc\n', theirs: 'a\nb\nc\nZ\n' }

describe('docSyncChange', () => {
  it('is the minimal replacement between the editor text and the model result', () => {
    expect(docSyncChange('abc', 'abc')).toBeNull()
    expect(docSyncChange('one\ntwo\nthree\n', 'one\nOURS\nthree\n')).toEqual({ from: 4, to: 7, insert: 'OURS' })
    expect(docSyncChange('ab', 'abab')).toEqual({ from: 2, to: 2, insert: 'ab' })
    expect(docSyncChange('abab', 'ab')).toEqual({ from: 2, to: 4, insert: '' })
    expect(docSyncChange('', 'x\n')).toEqual({ from: 0, to: 0, insert: 'x\n' })
  })
})

describe('userEdits / syncSpec', () => {
  it('reports a typed change as one edit in Result offsets', () => {
    const state = EditorState.create({ doc: 'one\ntwo\n' })
    const tr = state.update({ changes: { from: 4, to: 7, insert: 'TWO' } })
    expect(userEdits(tr)).toEqual([{ from: 4, to: 7, insert: 'TWO' }])
  })

  it('maps several changes of one transaction to sequential edits', () => {
    const state = EditorState.create({ doc: 'aaaa\nbbbb\n' })
    const tr = state.update({ changes: [{ from: 0, to: 1, insert: 'XYZ' }, { from: 5, to: 6, insert: '' }] })
    const edits = userEdits(tr)
    let text = 'aaaa\nbbbb\n'
    for (const edit of edits) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
    expect(text).toBe(tr.newDoc.toString())
  })

  it('model-driven syncs carry MODEL_CHANGE and are ignored; no-op syncs return null', () => {
    const state = EditorState.create({ doc: 'one\ntwo\n' })
    expect(syncSpec(state, 'one\ntwo\n')).toBeNull()
    const spec = syncSpec(state, 'one\nOURS\n')
    expect(spec).not.toBeNull()
    const tr = state.update(spec!)
    expect(tr.annotation(MODEL_CHANGE)).toBe(true)
    expect(tr.newDoc.toString()).toBe('one\nOURS\n')
    expect(userEdits(tr)).toEqual([])
    // A selection-only transaction is not an edit either.
    expect(userEdits(state.update({ selection: { anchor: 1 } }))).toEqual([])
  })
})

/** Result editor + store wired the way MergeWindow wires them (without a DOM). */
async function harness() {
  const side = (body: string, blob: string): MergeSide => ({ blob, text: body, binary: false, size: body.length })
  const value: MergeFileValue = {
    path: 'a.txt',
    kind: 'both-modified',
    base: side(CONFLICT.base, '1'.repeat(40)),
    ours: side(CONFLICT.ours, '2'.repeat(40)),
    theirs: side(CONFLICT.theirs, '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: null,
    draft: null,
    draftStale: false,
    resolved: false,
  }
  const store = createMergeStore({
    loadFile: async () => ({ ok: true, value }) as RpcResult<MergeFileValue>,
    actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'],
  })
  await store.open('a.txt')
  let state = EditorState.create({ doc: store.getState().model!.result })
  const edits = vi.fn((from: number, to: number, insert: string) => { store.edit(from, to, insert) })
  /** The editor's update listener: user transactions go to the store. */
  const type = (changes: { from: number; to?: number; insert: string }): void => {
    const tr = state.update({ changes })
    state = tr.state
    for (const edit of userEdits(tr)) edits(edit.from, edit.to, edit.insert)
  }
  /** The window's effect after every model change: push the model result into the editor. */
  const sync = (): void => {
    const spec = syncSpec(state, store.getState().model!.result)
    if (spec === null) return
    const tr = state.update(spec)
    state = tr.state
    for (const edit of userEdits(tr)) edits(edit.from, edit.to, edit.insert)
  }
  return { store, edits, type, sync, doc: () => state.doc.toString() }
}

describe('Result editor ↔ store', () => {
  it('a chunk button changes the Result and the editor follows without a feedback edit', async () => {
    const h = await harness()
    h.store.dispatch({ type: 'accept', id: 0, side: 'left' })
    h.sync()
    expect(h.doc()).toBe('one\nOURS\nthree\n')
    expect(h.edits).not.toHaveBeenCalled()
    expect(h.store.getState().model!.chunks[0]!.state).toBe('left')
  })

  it('typing inside a chunk marks it edited (no more chunk actions)', async () => {
    const h = await harness()
    h.type({ from: 4, to: 7, insert: 'mine' })
    expect(h.edits).toHaveBeenCalledWith(4, 7, 'mine')
    const model = h.store.getState().model!
    expect(model.result).toBe('one\nmine\nthree\n')
    expect(model.chunks[0]!.state).toBe('edited')
    expect(gutterActions(model, 'left')).toEqual([])
    h.sync()
    expect(h.doc()).toBe('one\nmine\nthree\n')
  })

  it('undo of a chunk action restores the Result through the store history', async () => {
    const h = await harness()
    h.store.dispatch({ type: 'accept', id: 0, side: 'right' })
    h.sync()
    expect(h.doc()).toBe('one\nTHEIRS\nthree\n')
    expect(h.store.undo()).toBe(true)
    h.sync()
    expect(h.doc()).toBe('one\ntwo\nthree\n')
    expect(h.store.getState().model!.chunks[0]!.state).toBe('pending')
    expect(h.store.redo()).toBe(true)
    h.sync()
    expect(h.doc()).toBe('one\nTHEIRS\nthree\n')
    expect(h.edits).not.toHaveBeenCalled()
  })
})

describe('chunkMarks', () => {
  it('colours a pending conflict in every pane and marks the current chunk', () => {
    const model = createModel(CONFLICT)
    expect(chunkMarks(model, 'left', 0)).toEqual([{ id: 0, from: 1, to: 2, tone: 'conflict', current: true }])
    expect(chunkMarks(model, 'result', null)).toEqual([{ id: 0, from: 1, to: 2, tone: 'conflict', current: false }])
    expect(chunkMarks(model, 'right', null)).toEqual([{ id: 0, from: 1, to: 2, tone: 'conflict', current: false }])
  })

  it('one-sided changes only show on their side and in the Result', () => {
    const model = createModel(ONE_SIDED)
    expect(chunkMarks(model, 'left', null).map(mark => mark.id)).toEqual([0])
    expect(chunkMarks(model, 'right', null).map(mark => mark.id)).toEqual([1])
    expect(chunkMarks(model, 'result', null).map(mark => [mark.id, mark.tone])).toEqual([[0, 'change'], [1, 'change']])
  })

  it('resolved and manually edited chunks change tone', () => {
    const whole = resolveWhole(createModel(CONFLICT), 0, 'left')
    expect(chunkMarks(whole, 'result', null)[0]!.tone).toBe('resolved')
    expect(chunkMarks(whole, 'left', null)[0]!.tone).toBe('resolved')
    const edited = applyEdit(createModel(CONFLICT), 4, 7, 'mine')
    expect(chunkMarks(edited, 'result', null)[0]!.tone).toBe('edited')
    expect(chunkMarks(edited, 'left', null)[0]!.tone).toBe('resolved')
  })
})

describe('lineClasses', () => {
  it('turns line ranges into 1-based editor lines; empty ranges mark an insertion point', () => {
    expect(lineClasses([{ id: 0, from: 1, to: 3, tone: 'conflict', current: false }], 5)).toEqual([
      { line: 2, tone: 'conflict', current: false, edge: 'first' },
      { line: 3, tone: 'conflict', current: false, edge: 'last' },
    ])
    expect(lineClasses([{ id: 0, from: 1, to: 2, tone: 'change', current: true }], 5)).toEqual([
      { line: 2, tone: 'change', current: true, edge: 'single' },
    ])
    expect(lineClasses([{ id: 0, from: 1, to: 1, tone: 'change', current: false }], 5)).toEqual([
      { line: 2, tone: 'change', current: false, edge: 'gapBefore' },
    ])
    // At the end of the document the marker sits under the last line.
    expect(lineClasses([{ id: 0, from: 3, to: 3, tone: 'change', current: false }], 3)).toEqual([
      { line: 3, tone: 'change', current: false, edge: 'gapAfter' },
    ])
    expect(lineClasses([{ id: 0, from: 0, to: 0, tone: 'change', current: false }], 0)).toEqual([])
  })
})

describe('gutterActions / gutterAction', () => {
  it('offers accept/ignore on the side that changed, at the chunk start line', () => {
    const model = createModel(ONE_SIDED)
    expect(gutterActions(model, 'left')).toEqual([{ line: 1, chunks: [{ id: 0, side: 'left', conflict: false }] }])
    expect(gutterActions(model, 'right')).toEqual([{ line: 3, chunks: [{ id: 1, side: 'right', conflict: false }] }])
    expect(gutterActions(model, 'result')).toEqual([])
  })

  it('a side already taken or ignored has no more buttons', () => {
    const model = resolveWhole(createModel(CONFLICT), 0, 'left')
    expect(gutterActions(model, 'left')).toEqual([])
    expect(gutterActions(model, 'right')).toEqual([])
    expect(gutterActions(createModel(CONFLICT), 'right')).toEqual([{ line: 1, chunks: [{ id: 0, side: 'right', conflict: true }] }])
  })

  it('Ctrl/Cmd+click on accept resolves the whole chunk', () => {
    expect(gutterAction('accept', 3, 'left', false)).toEqual({ type: 'accept', id: 3, side: 'left' })
    expect(gutterAction('accept', 3, 'right', true)).toEqual({ type: 'resolveWhole', id: 3, side: 'right' })
    expect(gutterAction('ignore', 3, 'left', true)).toEqual({ type: 'ignore', id: 3, side: 'left' })
  })
})

describe('mapLine', () => {
  it('maps lines between panes with chunks as anchors', () => {
    const model = createModel(ONE_SIDED)
    // Common lines before / after a chunk keep their offset.
    expect(mapLine(model, 'left', 'result', 0)).toBe(0)
    expect(mapLine(model, 'left', 'result', 3)).toBe(1)
    expect(mapLine(model, 'left', 'result', 4)).toBe(2)
    expect(mapLine(model, 'result', 'left', 1)).toBe(3)
    // Lines inside a chunk that is empty on the other pane collapse onto its position.
    expect(mapLine(model, 'left', 'result', 1)).toBe(1)
    expect(mapLine(model, 'left', 'result', 2.5)).toBe(1)
    expect(mapLine(model, 'right', 'result', 3)).toBe(3)
    expect(mapLine(model, 'right', 'left', 3.5)).toBe(5)
    // Fractions in common regions are kept.
    expect(mapLine(model, 'result', 'left', 0.5)).toBe(0.5)
  })

  it('is proportional inside chunks of different sizes and identity for the same pane', () => {
    const model = createModel({ base: 'a\nb\nz\n', ours: 'a\n1\n2\nz\n', theirs: 'a\nq\nr\ns\nt\nz\n' })
    expect(model.chunks).toHaveLength(1)
    expect(mapLine(model, 'left', 'right', 1)).toBe(1)
    expect(mapLine(model, 'left', 'right', 2)).toBe(3)
    expect(mapLine(model, 'left', 'right', 3)).toBe(5)
    expect(mapLine(model, 'right', 'left', 5)).toBe(3)
    expect(mapLine(model, 'left', 'left', 2.25)).toBe(2.25)
  })
})

describe('createScrollLock', () => {
  it('lets one pane drive until two frames after its last scroll', () => {
    const frames: Array<() => void> = []
    const lock = createScrollLock((callback) => { frames.push(callback) })
    const tick = (): void => { for (const callback of frames.splice(0)) callback() }
    expect(lock.begin('left')).toBe(true)
    // The panes it moved report scroll events: ignored.
    expect(lock.begin('result')).toBe(false)
    expect(lock.begin('right')).toBe(false)
    tick()
    expect(lock.begin('result')).toBe(false)
    tick()
    expect(lock.begin('result')).toBe(true)
    // The driver keeps driving; an older release does not end a newer drive.
    expect(lock.begin('result')).toBe(true)
    tick()
    tick()
    expect(lock.begin('left')).toBe(true)
  })
})
