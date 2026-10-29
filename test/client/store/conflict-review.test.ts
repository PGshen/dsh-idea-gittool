// B1 T7 conflict list enhancements in the conflict store: reviewed state (per operation, in memory),
// lazy chunk counts (first 50 text conflicts, cached by stages, drafts counted), the bottom button
// (manualButton three states), the Review Changes queue order and row selection.
import { describe, expect, it, vi } from 'vitest'
import { createModel, resolveWhole, toDraft } from '../../../src/client/merge/merge-model.ts'
import {
  CHUNK_COUNT_LIMIT,
  createConflictStore,
  manualButton,
  nextSelection,
  reviewInputs,
  reviewQueue,
} from '../../../src/client/store/conflict-store.ts'
import type { ReviewGroups } from '../../../src/client/store/conflict-store.ts'
import type { MergeFileValue, MergeSide, OperationStateValue, RpcResult } from '../../../src/shared/protocol.ts'
import { conflictEntry, mergeState, rebaseState } from '../pages/operation-fixtures.ts'

const set = (...paths: string[]): ReadonlySet<string> => new Set(paths)

describe('manualButton (confirmation 2 three states)', () => {
  const groups: ReviewGroups = { unresolved: ['u1', 'u2'], resolved: ['r1', 'r2'] }

  it.each([
    ['nothing selected, unresolved files remain', groups, set(), set('r1', 'r2'), 'resolveManually'],
    ['a selected file is unresolved', groups, set('u2', 'r1'), set(), 'resolveManually'],
    ['only resolved files selected, some unreviewed', groups, set('r1'), set('r1'), 'reviewChanges'],
    ['all resolved, one unreviewed', { unresolved: [], resolved: ['r1', 'r2'] }, set(), set('r1'), 'reviewChanges'],
    ['resolved selection, all reviewed, unresolved remain', groups, set('r1'), set('r1', 'r2'), 'resolveManually'],
    ['all resolved and reviewed', { unresolved: [], resolved: ['r1', 'r2'] }, set(), set('r1', 'r2'), null],
    ['nothing at all', { unresolved: [], resolved: [] }, set(), set(), null],
  ] as const)('%s', (_name, input, selected, reviewed, label) => {
    expect(manualButton(input, selected, reviewed)?.label ?? null).toBe(label)
  })
})

describe('reviewQueue: selected → other unresolved → resolved unreviewed, de-duplicated', () => {
  const groups: ReviewGroups = { unresolved: ['u1', 'u2', 'u3'], resolved: ['r1', 'r2', 'r3'] }

  it('without a selection: unresolved in list order, then unreviewed resolved files', () => {
    expect(reviewQueue(groups, set(), set('r2'))).toEqual(['u1', 'u2', 'u3', 'r1', 'r3'])
  })

  it('selected files first (list order), reviewed ones too when selected', () => {
    expect(reviewQueue(groups, set('r2', 'u3'), set('r2'))).toEqual(['u3', 'r2', 'u1', 'u2', 'r1', 'r3'])
  })

  it('a selected path outside the groups (not reviewable) is skipped', () => {
    expect(reviewQueue(groups, set('gone'), set('r1', 'r2', 'r3'))).toEqual(['u1', 'u2', 'u3'])
  })
})

describe('nextSelection: click, Cmd/Ctrl toggle, Shift range over both groups', () => {
  const order = ['u1', 'u2', 'r1', 'r2']
  const none = { selected: set(), anchor: null }

  it('a plain click selects only that row and sets the anchor', () => {
    const next = nextSelection(order, { selected: set('u1', 'r1'), anchor: 'u1' }, 'u2', { toggle: false, range: false })
    expect([...next.selected]).toEqual(['u2'])
    expect(next.anchor).toBe('u2')
  })

  it('Cmd/Ctrl toggles a row', () => {
    const one = nextSelection(order, none, 'u1', { toggle: true, range: false })
    const two = nextSelection(order, one, 'r1', { toggle: true, range: false })
    expect([...two.selected].sort()).toEqual(['r1', 'u1'])
    const back = nextSelection(order, two, 'u1', { toggle: true, range: false })
    expect([...back.selected]).toEqual(['r1'])
  })

  it('Shift selects the range from the anchor across groups', () => {
    const anchor = nextSelection(order, none, 'u2', { toggle: false, range: false })
    const range = nextSelection(order, anchor, 'r2', { toggle: false, range: true })
    expect([...range.selected]).toEqual(['u2', 'r1', 'r2'])
    expect(range.anchor).toBe('u2')
    const up = nextSelection(order, range, 'u1', { toggle: false, range: true })
    expect([...up.selected]).toEqual(['u1', 'u2'])
  })
})

// ---- store: reviewed state and chunk counts ----

const side = (body: string | null, blob: string): MergeSide => ({ blob, text: body, binary: body === null, size: body?.length ?? 0 })
const SIDES = { base: 'a\nb\nc\nd\n', ours: 'a\nB1\nc\nD1\n', theirs: 'a\nB2\nc\nD2\n' }

function mergeFile(path: string, over: Partial<MergeFileValue> = {}): MergeFileValue {
  return {
    path,
    kind: 'both-modified',
    base: side(SIDES.base, '1'.repeat(40)),
    ours: side(SIDES.ours, '2'.repeat(40)),
    theirs: side(SIDES.theirs, '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: 'f'.repeat(40),
    draft: null,
    draftStale: false,
    resolved: false,
    ...over,
  }
}

function storeWith(states: OperationStateValue[], files: (path: string) => MergeFileValue = path => mergeFile(path)) {
  const load = vi.fn(async () => ({ ok: true as const, value: states.length > 1 ? states.shift()! : states[0]! }))
  const loadFile = vi.fn(async (path: string) => ({ ok: true, value: files(path) }) as RpcResult<MergeFileValue>)
  return { store: createConflictStore({ load, loadFile }), load, loadFile }
}

describe('reviewed state', () => {
  it('files seen unresolved and resolved later are unreviewed until marked; changing operation clears it', async () => {
    const { store } = storeWith([
      mergeState({ conflicts: [conflictEntry('a'), conflictEntry('b')], resolved: ['auto'] }),
      mergeState({ conflicts: [conflictEntry('b')], resolved: ['auto', 'a'] }),
      mergeState({ conflicts: [], resolved: ['auto', 'a', 'b'] }),
      mergeState({ theirs: { label: 'other', sha: '9'.repeat(40) }, conflicts: [], resolved: ['a'] }),
    ])
    await store.refresh()
    await store.refresh()
    let input = reviewInputs(store.getState().value, store.getReview())
    // `auto` never conflicted in this session: it counts as reviewed (D5) and is reviewable only on demand.
    expect(input.groups).toEqual({ unresolved: ['b'], resolved: ['auto', 'a'] })
    expect(input.reviewed.has('auto')).toBe(true)
    expect(input.reviewed.has('a')).toBe(false)
    store.markReviewed('a')
    await store.refresh()
    input = reviewInputs(store.getState().value, store.getReview())
    expect(input.reviewed.has('a')).toBe(true)
    expect(input.reviewed.has('b')).toBe(false)
    expect(manualButton(input.groups, set(), input.reviewed)?.label).toBe('reviewChanges')
    store.unmarkReviewed(['a'])
    expect(store.getReview().reviewed.has('a')).toBe(false)
    await store.refresh()
    // Another operation: in-memory state starts over (and nothing was seen unresolved there).
    input = reviewInputs(store.getState().value, store.getReview())
    expect(input.reviewed.has('a')).toBe(true)
    expect(manualButton(input.groups, set(), input.reviewed)).toBeNull()
  })

  it('delete-kind conflicts and files found not reviewable leave the reviewable group', async () => {
    const { store } = storeWith([
      mergeState({ conflicts: [conflictEntry('gone', 'deleted-by-them'), conflictEntry('t')], resolved: [] }),
      mergeState({ conflicts: [], resolved: ['gone', 't'] }),
    ])
    await store.refresh()
    await store.refresh()
    let input = reviewInputs(store.getState().value, store.getReview())
    expect(input.groups.resolved).toEqual(['gone', 't'])
    expect(input.reviewed.has('gone')).toBe(true)
    expect(input.reviewed.has('t')).toBe(false)
    store.markNotReviewable('t')
    input = reviewInputs(store.getState().value, store.getReview())
    expect(input.groups.resolved).toEqual(['gone'])
    expect(reviewQueue(input.groups, set('t'), input.reviewed)).toEqual([])
  })

  it('a rebase step starts a new review round', async () => {
    const { store } = storeWith([
      rebaseState({ conflicts: [conflictEntry('a')], step: { current: 1, total: 3 } }),
      rebaseState({ conflicts: [], resolved: ['a'], step: { current: 1, total: 3 } }),
      rebaseState({ conflicts: [], resolved: ['a'], step: { current: 2, total: 3 } }),
    ])
    await store.refresh()
    await store.refresh()
    expect(reviewInputs(store.getState().value, store.getReview()).reviewed.has('a')).toBe(false)
    await store.refresh()
    expect(reviewInputs(store.getState().value, store.getReview()).reviewed.has('a')).toBe(true)
  })
})

describe('chunk counts', () => {
  it('loads counts lazily and serially for unresolved text conflicts; binary files have none', async () => {
    const { store, loadFile } = storeWith(
      [mergeState({ conflicts: [conflictEntry('a'), conflictEntry('bin'), conflictEntry('del', 'deleted-by-us')], resolved: [] })],
      path => (path === 'bin' ? mergeFile(path, { ours: side(null, '2'.repeat(40)) }) : mergeFile(path)),
    )
    await store.refresh()
    expect(loadFile).not.toHaveBeenCalled()
    await store.loadCounts()
    expect(loadFile.mock.calls.map(call => call[0])).toEqual(['a', 'bin'])
    expect(store.getReview().counts.get('a')).toEqual({ resolved: 0, total: 2 })
    expect(store.getReview().counts.get('bin')).toBeNull()
    expect(store.getReview().counts.has('del')).toBe(false)
    // Cached: a second pass loads nothing until the path is invalidated.
    await store.loadCounts()
    expect(loadFile).toHaveBeenCalledTimes(2)
    store.invalidateCount('a')
    expect(store.getReview().counts.has('a')).toBe(false)
    await store.loadCounts()
    expect(loadFile).toHaveBeenCalledTimes(3)
  })

  it('a saved draft is counted by its chunk states', async () => {
    const draft = toDraft(resolveWhole(createModel(SIDES), 0, 'left'), { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) })
    const { store } = storeWith([mergeState({ conflicts: [conflictEntry('a')], resolved: [] })], path => mergeFile(path, { draft }))
    await store.refresh()
    await store.loadCounts()
    expect(store.getReview().counts.get('a')).toEqual({ resolved: 1, total: 2 })
  })

  it(`only the first ${CHUNK_COUNT_LIMIT} unresolved text conflicts are counted`, async () => {
    const conflicts = Array.from({ length: CHUNK_COUNT_LIMIT + 5 }, (_, i) => conflictEntry(`f${i}`))
    const { store, loadFile } = storeWith([mergeState({ conflicts, resolved: [] })])
    await store.refresh()
    await store.loadCounts()
    expect(loadFile).toHaveBeenCalledTimes(CHUNK_COUNT_LIMIT)
    expect(store.getReview().counts.has(`f${CHUNK_COUNT_LIMIT}`)).toBe(false)
  })

  it('T2: a failed load is not retried on every pass, only after the file was invalidated or the round changed', async () => {
    const states = [
      mergeState({ conflicts: [conflictEntry('a'), conflictEntry('b')], resolved: [] }),
      mergeState({ conflicts: [conflictEntry('a'), conflictEntry('b')], resolved: [] }),
      rebaseState({ conflicts: [conflictEntry('a'), conflictEntry('b')], resolved: [] }),
    ]
    const load = vi.fn(async () => ({ ok: true as const, value: states.length > 1 ? states.shift()! : states[0]! }))
    let failA = true
    const loadFile = vi.fn(async (path: string) => (path === 'a' && failA
      ? { ok: false, error: { code: 'git/exec-failed', message: 'boom' } }
      : { ok: true, value: mergeFile(path) }) as RpcResult<MergeFileValue>)
    const store = createConflictStore({ load, loadFile })
    await store.refresh()
    await store.loadCounts()
    expect(loadFile.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    expect(store.getReview().counts.has('a')).toBe(false)
    // The next refresh of the same round (same file) does not ask again.
    await store.refresh()
    await store.loadCounts()
    expect(loadFile).toHaveBeenCalledTimes(2)
    // The file changed (window left / resolved / restored): it is tried again.
    store.invalidateCount('a')
    await store.loadCounts()
    expect(loadFile).toHaveBeenCalledTimes(3)
    // A new round (other stages) tries again too.
    failA = false
    await store.refresh()
    await store.loadCounts()
    expect(loadFile.mock.calls.map(call => call[0]).slice(3)).toEqual(['a', 'b'])
    expect(store.getReview().counts.get('a')).toEqual({ resolved: 0, total: 2 })
  })
})

describe('T2: where conflicts without an operation came from', () => {
  it('defaults to the stash; a shelf three-way apply marks it until the list is cleared', async () => {
    const { store } = storeWith([mergeState({ operation: null, conflicts: [conflictEntry('a')], resolved: [] })])
    expect(store.getState().origin ?? 'stash').toBe('stash')
    store.noteOrigin('shelf')
    expect(store.getState().origin).toBe('shelf')
    await store.refresh()
    expect(store.getState().origin).toBe('shelf')
    store.clear()
    expect(store.getState().origin ?? 'stash').toBe('stash')
    store.noteOrigin('shelf')
    store.noteOrigin('stash')
    expect(store.getState().origin).toBe('stash')
  })
})
