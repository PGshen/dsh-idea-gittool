// A3 T9 conflict store: loading operationState, the two groups, side labels by concrete names,
// row actions (incl. DU/UD keep/delete) and the once-per-operation auto-open tracker.
import { describe, expect, it, vi } from 'vitest'
import {
  conflictGroups,
  conflictKindText,
  conflictRowActions,
  conflictListSync,
  conflictSides,
  createAutoOpenTracker,
  createConflictStore,
  operationIdentity,
  withStashLabel,
} from '../../../src/client/store/conflict-store.ts'
import { render } from '../../../src/client/localized-text.ts'
import type { OperationStateValue, RpcResult } from '../../../src/shared/protocol.ts'
import { zhT } from '../i18n-helpers.tsx'
import { conflictEntry, idleState, mergeState, pickState, rebaseState, stashPopState } from '../pages/operation-fixtures.ts'

const say = (value: Parameters<typeof render>[1]): string => render(zhT, value)

describe('createConflictStore', () => {
  it('loads operationState and exposes it; errors are kept without dropping the old value', async () => {
    const results: RpcResult<OperationStateValue>[] = [
      { ok: true, value: mergeState() },
      { ok: false, error: { code: 'git/exec-failed', message: 'boom' } },
    ]
    const load = vi.fn(async () => results.shift() ?? { ok: true as const, value: idleState() })
    const store = createConflictStore({ load })
    expect(store.getState().status).toBe('idle')
    const pending = store.refresh()
    expect(store.getState().status).toBe('loading')
    await pending
    expect(store.getState()).toMatchObject({ status: 'ready', error: null })
    expect(store.getState().value?.operation).toBe('merge')
    await store.refresh()
    expect(store.getState().status).toBe('error')
    expect(store.getState().error?.code).toBe('git/exec-failed')
    expect(store.getState().value?.operation).toBe('merge')
  })

  it('a slower older response never overwrites a newer one; clear() drops the value', async () => {
    let first!: (value: RpcResult<OperationStateValue>) => void
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<RpcResult<OperationStateValue>>((resolve) => { first = resolve }))
      .mockImplementationOnce(async () => ({ ok: true, value: rebaseState() }))
    const store = createConflictStore({ load })
    const older = store.refresh()
    await store.refresh()
    first({ ok: true, value: mergeState() })
    await older
    expect(store.getState().value?.operation).toBe('rebase')
    store.clear()
    expect(store.getState()).toMatchObject({ status: 'idle', value: null })
  })

  it('notifies subscribers', async () => {
    const store = createConflictStore({ load: async () => ({ ok: true, value: mergeState() }) })
    const listener = vi.fn()
    const off = store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalled()
    off()
  })
})

describe('conflictGroups', () => {
  it('unresolved = current conflicts, resolved = resolved paths not conflicting again', () => {
    expect(conflictGroups(mergeState())).toEqual({
      unresolved: [conflictEntry('src/a.ts'), conflictEntry('src/b.ts')],
      resolved: ['src/c.ts'],
    })
    expect(conflictGroups(null)).toEqual({ unresolved: [], resolved: [] })
  })

  it('a resolved file moves from the first group to the second after the refresh', () => {
    const after = mergeState({ conflicts: [conflictEntry('src/b.ts')], resolved: ['src/a.ts', 'src/c.ts'] })
    const groups = conflictGroups(after)
    expect(groups.unresolved.map(entry => entry.path)).toEqual(['src/b.ts'])
    expect(groups.resolved).toEqual(['src/a.ts', 'src/c.ts'])
  })
})

describe('conflictSides: concrete names, ours/theirs in the tooltip', () => {
  it('merge: left = current branch (ours), right = merged branch (theirs)', () => {
    const sides = conflictSides(mergeState())
    expect(say(sides.ours.name)).toBe('main（当前分支）')
    expect(say(sides.theirs.name)).toBe('feature（被合并）')
    expect(say(sides.ours.take)).toBe('采用 main')
    expect(say(sides.theirs.take)).toBe('采用 feature')
    expect(say(sides.ours.title)).toContain('ours')
    expect(say(sides.theirs.title)).toContain('theirs')
    expect(sides.note).toBeNull()
  })

  it('rebase: ours is the target branch, theirs the replayed commits, with the rebase note', () => {
    const sides = conflictSides(rebaseState())
    expect(say(sides.ours.name)).toBe('main（目标分支）')
    expect(say(sides.theirs.name)).toBe('feat/x 的提交')
    expect(say(sides.ours.take)).toBe('采用 main')
    expect(say(sides.theirs.take)).toBe('采用 feat/x')
    expect(say(sides.ours.title)).toContain('目标分支')
    expect(sides.note).not.toBeNull()
    expect(say(sides.note!)).toContain('ours 是目标分支')
  })

  it.each([
    ['cherry-pick', '（被拣选）'],
    ['revert', '（被回滚）'],
  ] as const)('%s: left = current branch, right = the commit %s', (operation, suffix) => {
    const sides = conflictSides(pickState(operation))
    expect(say(sides.ours.name)).toBe('main（当前分支）')
    expect(say(sides.theirs.name)).toBe(`4abcdef${suffix}`)
    expect(say(sides.theirs.take)).toBe('采用 4abcdef')
  })
})

describe('conflictRowActions', () => {
  const ids = (value: OperationStateValue, kind: Parameters<typeof conflictEntry>[1]) =>
    conflictRowActions(conflictEntry('f', kind), value).map(action => [action.id, action.resolution, say(action.label)])

  it('content conflicts: take ours / take theirs by name, and mark resolved', () => {
    expect(ids(mergeState(), 'both-modified')).toEqual([
      ['ours', 'ours', '采用 main'],
      ['theirs', 'theirs', '采用 feature'],
      ['mark', 'mark-resolved', '标记已解决'],
    ])
    expect(ids(rebaseState(), 'both-added').map(row => row[2])).toEqual(['采用 main', '采用 feat/x', '标记已解决'])
  })

  it('deleted by us (DU): keep = the theirs version, delete; deleted by them (UD): keep = ours', () => {
    expect(ids(mergeState(), 'deleted-by-us')).toEqual([
      ['keep', 'theirs', '保留文件'],
      ['delete', 'delete', '删除文件'],
    ])
    expect(ids(mergeState(), 'deleted-by-them')).toEqual([
      ['keep', 'ours', '保留文件'],
      ['delete', 'delete', '删除文件'],
    ])
    const [keep] = conflictRowActions(conflictEntry('f', 'deleted-by-us'), mergeState())
    expect(say(keep!.title)).toContain('feature')
  })

  it('added by one side keeps that side; both deleted only deletes', () => {
    expect(ids(mergeState(), 'added-by-us').map(row => row[1])).toEqual(['ours', 'delete'])
    expect(ids(mergeState(), 'added-by-them').map(row => row[1])).toEqual(['theirs', 'delete'])
    expect(ids(mergeState(), 'both-deleted')).toEqual([['delete', 'delete', '删除文件']])
  })

  it('an entry without a kind is treated as a content conflict', () => {
    expect(ids(mergeState(), undefined).map(row => row[0])).toEqual(['ours', 'theirs', 'mark'])
  })

  it('kind text names the side', () => {
    expect(say(conflictKindText(conflictEntry('f', 'deleted-by-them'), mergeState()))).toContain('feature')
    expect(say(conflictKindText(conflictEntry('f', 'both-modified'), mergeState()))).toBe('双方修改')
  })
})

describe('auto-open tracker', () => {
  it('opens once when an operation with conflicts appears after an idle state; never again after that', () => {
    const tracker = createAutoOpenTracker()
    expect(tracker.observe(null)).toBe(false)
    expect(tracker.observe(mergeState())).toBe(true)
    // The user closed the list; later polls of the same operation do not reopen it.
    expect(tracker.observe(mergeState())).toBe(false)
    expect(tracker.observe(mergeState({ conflicts: [conflictEntry('src/b.ts')] }))).toBe(false)
  })

  it('a new operation (after the old one ended) opens again', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    expect(tracker.observe(mergeState())).toBe(true)
    tracker.observe(idleState())
    expect(tracker.observe(rebaseState())).toBe(true)
  })

  it('does not open for an operation without conflicts, and opens when the same one later has some', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    expect(tracker.observe(mergeState({ conflicts: [] }))).toBe(false)
    expect(tracker.observe(mergeState())).toBe(true)
  })

  it('rebase steps keep the same identity (HEAD moves, onto and branch stay)', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    expect(tracker.observe(rebaseState())).toBe(true)
    expect(tracker.observe(rebaseState({ step: { current: 3, total: 5 } }))).toBe(false)
    expect(operationIdentity(rebaseState())).toBe(operationIdentity(rebaseState({ step: { current: 4, total: 5 } })))
    expect(operationIdentity(mergeState())).not.toBe(operationIdentity(mergeState({ theirs: { label: 'other', sha: '9'.repeat(40) } })))
    expect(operationIdentity(idleState())).toBeNull()
  })

  it('an operation already in progress when the workbench mounts does not pop the list', () => {
    const tracker = createAutoOpenTracker()
    expect(tracker.observe(mergeState())).toBe(false)
    expect(tracker.observe(mergeState())).toBe(false)
  })

  it('opened by the action store (onConflict) before the state loaded: counts as this operation\'s open', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    tracker.noteOpened()
    expect(tracker.observe(mergeState())).toBe(false)
    expect(tracker.observe(mergeState())).toBe(false)
  })

  it('opened while the state is known marks that operation', () => {
    const tracker = createAutoOpenTracker()
    expect(tracker.observe(null)).toBe(false)
    expect(tracker.observe(mergeState({ conflicts: [] }))).toBe(false)
    tracker.noteOpened()
    expect(tracker.observe(mergeState())).toBe(false)
  })
})

describe('carry 4: conflicts left by restoring the stash (operation null)', () => {
  it('sides are the current branch and the stashed changes; rows still offer both sides and mark resolved', () => {
    const value = withStashLabel(stashPopState(), zhT('conflict.stashLabel'))
    const sides = conflictSides(value)
    expect(say(sides.ours.name)).toBe('main（当前分支）')
    expect(say(sides.theirs.name)).toBe('贮藏的改动')
    expect(say(sides.theirs.take)).toBe('采用 贮藏的改动')
    expect(say(sides.theirs.title)).toContain('theirs')
    expect(sides.note).toBeNull()
    const [content] = value.conflicts
    expect(conflictRowActions(content!, value).map(action => action.id)).toEqual(['ours', 'theirs', 'mark'])
    expect(say(conflictKindText(value.conflicts[1]!, value))).toBe('贮藏的改动 新增')
  })

  it('withStashLabel only touches the no-operation case', () => {
    const merge = mergeState()
    expect(withStashLabel(merge, 'x')).toBe(merge)
  })

  it('the list stays loaded while unmerged entries remain without an operation, and closes when they are gone', () => {
    // A merge finished, but popping the stash conflicted: keep (and reload) the list.
    expect(conflictListSync(true, null, 2)).toEqual({ load: 'refresh', close: false, active: true })
    expect(conflictListSync(false, null, 2)).toEqual({ load: 'refresh', close: false, active: true })
    // All resolved: nothing left to show.
    expect(conflictListSync(true, null, 0)).toEqual({ load: 'clear', close: true, active: false })
    expect(conflictListSync(false, null, 0)).toEqual({ load: 'clear', close: false, active: false })
    expect(conflictListSync(false, 'merge', 0)).toEqual({ load: 'refresh', close: false, active: true })
  })
})

describe('carry 11: going idle forgets which operations were shown', () => {
  it('restarting the same merge later auto-opens the list again', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    expect(tracker.observe(mergeState())).toBe(true)
    expect(tracker.observe(mergeState())).toBe(false)
    tracker.observe(null)
    expect(tracker.observe(mergeState())).toBe(true)
  })

  it('stash-pop conflicts (no operation) never auto-open by themselves', () => {
    const tracker = createAutoOpenTracker()
    tracker.observe(null)
    expect(tracker.observe(stashPopState())).toBe(false)
  })
})
