// A3 T8 commit context menu: availability matrix and what each item does.
import { describe, expect, it } from 'vitest'
import {
  childOf,
  commitActionContext,
  commitActionEffect,
  commitActions,
  enabledAction,
  isContextMenuKey,
} from '../../../src/client/pages/commit-actions.ts'
import type { CommitActionContext } from '../../../src/client/pages/commit-actions.ts'
import { zh } from '../../../src/client/locales.ts'
import { render } from '../../../src/client/localized-text.ts'
import { zhT } from '../i18n-helpers.tsx'
import type { CommitSummary } from '../../../src/shared/protocol.ts'

const SHA = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)
const commit = (patch: Partial<CommitSummary> = {}): CommitSummary => ({
  sha: SHA, shortSha: 'aaaaaaa', parents: [PARENT], author: 'x', email: 'x@y', date: '2026-10-25T00:00:00Z', subject: 'feat: x', ...patch,
})
const ctx = (patch: Partial<CommitActionContext> = {}): CommitActionContext => ({
  writable: true, operation: null, parentLoaded: true, childLoaded: true, ...patch,
})
const find = (items: ReturnType<typeof commitActions>, id: string) => items.find(item => item.id === id)

describe('commitActions', () => {
  it('offers the P0 items in order, all enabled on a normal commit', () => {
    const items = commitActions(commit(), ctx())
    expect(items.map(item => item.id)).toEqual([
      'copyHash', 'copyShortHash', 'copyMessage', 'checkout', 'newBranch', 'cherryPick', 'revert', 'resetTo', 'goParent', 'goChild',
      'compareWorktree', 'compareSelected',
    ])
    // B2: comparing needs two selected commits; everything else is enabled on a normal commit.
    expect(items.filter(item => item.disabledReason !== undefined).map(item => item.id)).toEqual(['compareSelected'])
  })

  it('only the reset item is drawn in the danger tone; checkout warns about detached HEAD', () => {
    const items = commitActions(commit(), ctx())
    expect(items.filter(item => item.danger === true).map(item => item.id)).toEqual(['resetTo'])
    expect(zhT(find(items, 'checkout')!.label.key)).toContain('detached')
  })

  it('merge commits disable cherry-pick and revert with the parent-selection reason', () => {
    const items = commitActions(commit({ parents: [PARENT, 'c'.repeat(40)] }), ctx())
    for (const id of ['cherryPick', 'revert']) {
      const reason = find(items, id)!.disabledReason
      expect(reason && render(zhT, reason)).toBe('需要选择父提交（暂不支持）')
    }
    expect(find(items, 'resetTo')!.disabledReason).toBeUndefined()
  })

  it('read-only and operation-in-progress disable every write but keep copy and navigation', () => {
    for (const blocked of [ctx({ writable: false }), ctx({ operation: 'merge' })]) {
      const items = commitActions(commit(), blocked)
      for (const id of ['checkout', 'newBranch', 'cherryPick', 'revert', 'resetTo']) {
        expect(find(items, id)!.disabledReason, id).toBeDefined()
      }
      for (const id of ['copyHash', 'copyShortHash', 'copyMessage', 'goParent', 'goChild']) {
        expect(find(items, id)!.disabledReason, id).toBeUndefined()
      }
    }
    expect(render(zhT, find(commitActions(commit(), ctx({ writable: false })), 'resetTo')!.disabledReason!)).toBe(zh['branch.disabled.readOnly'])
    expect(render(zhT, find(commitActions(commit(), ctx({ operation: 'rebase' })), 'resetTo')!.disabledReason!)).toBe(zh['branch.disabled.operation'])
  })

  it('parent / child navigation explains why it is unavailable', () => {
    const root = commitActions(commit({ parents: [] }), ctx({ parentLoaded: false }))
    expect(render(zhT, find(root, 'goParent')!.disabledReason!)).toBe(zh['commit.disabled.noParent'])
    const far = commitActions(commit(), ctx({ parentLoaded: false, childLoaded: false }))
    expect(render(zhT, find(far, 'goParent')!.disabledReason!)).toBe(zh['commit.disabled.parentNotLoaded'])
    expect(render(zhT, find(far, 'goChild')!.disabledReason!)).toBe(zh['commit.disabled.noChild'])
  })
})

describe('commitActionEffect', () => {
  const c = commit({ subject: 'feat: a\n\nbody' })
  it('copy items copy the full hash, the short hash and the subject', () => {
    expect(commitActionEffect('copyHash', c, null)).toEqual({ kind: 'copy', value: SHA })
    expect(commitActionEffect('copyShortHash', c, null)).toEqual({ kind: 'copy', value: 'aaaaaaa' })
    expect(commitActionEffect('copyMessage', c, null)).toEqual({ kind: 'copy', value: 'feat: a\n\nbody' })
  })
  it('checkout and new branch open the branch sheet prefilled with the commit', () => {
    expect(commitActionEffect('checkout', c, null)).toEqual({ kind: 'overlay', overlay: { kind: 'branchSheet', mode: 'checkoutRevision', revision: SHA } })
    expect(commitActionEffect('newBranch', c, null)).toEqual({ kind: 'overlay', overlay: { kind: 'branchSheet', mode: 'new', startPoint: SHA } })
  })
  it('cherry-pick and revert open the confirmation sheet; reset opens the reset sheet', () => {
    expect(commitActionEffect('cherryPick', c, null)).toEqual({
      kind: 'overlay', overlay: { kind: 'commitOp', op: 'cherryPick', sha: SHA, shortSha: 'aaaaaaa', subject: 'feat: a\n\nbody' },
    })
    expect(commitActionEffect('revert', c, null)).toMatchObject({ overlay: { kind: 'commitOp', op: 'revert' } })
    expect(commitActionEffect('resetTo', c, null)).toEqual({ kind: 'overlay', overlay: { kind: 'reset', sha: SHA } })
  })
  it('navigation jumps to the first parent / the given child', () => {
    expect(commitActionEffect('goParent', c, null)).toEqual({ kind: 'jump', sha: PARENT })
    expect(commitActionEffect('goChild', c, 'd'.repeat(40))).toEqual({ kind: 'jump', sha: 'd'.repeat(40) })
    expect(commitActionEffect('goChild', c, null)).toBeNull()
    expect(commitActionEffect('goParent', commit({ parents: [] }), null)).toBeNull()
  })
})

describe('isContextMenuKey', () => {
  it('ContextMenu key and Shift+F10 open the menu; plain F10 does not', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
  })
})

describe('loaded neighbours', () => {
  const log = [commit({ sha: 'd'.repeat(40), parents: [SHA] }), commit({ sha: SHA, parents: [PARENT] }), commit({ sha: PARENT, parents: [] })]
  it('finds the first loaded child (newest first) and whether the parent is loaded', () => {
    expect(childOf(log, SHA)).toBe('d'.repeat(40))
    expect(childOf(log, 'd'.repeat(40))).toBeNull()
    const base = { writable: true, operation: null } as const
    expect(commitActionContext(log, log[1]!, base)).toEqual({ writable: true, operation: null, parentLoaded: true, childLoaded: true })
    expect(commitActionContext(log, log[0]!, base)).toMatchObject({ parentLoaded: true, childLoaded: false })
    expect(commitActionContext([log[1]!], log[1]!, base)).toMatchObject({ parentLoaded: false })
  })
})

describe('B2 compare items', () => {
  const base = { writable: true, operation: null, parentLoaded: true, childLoaded: true }
  const one: CommitSummary = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', parents: ['p'], author: 'A', email: 'a@x', date: '2026-10-27T00:00:00Z', subject: 'one' }
  const two: CommitSummary = { ...one, sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'two' }
  const reasonOf = (selection: string[]): string | undefined =>
    commitActions(one, { ...base, selection }).find(item => item.id === 'compareSelected')?.disabledReason?.key

  it('compare with the worktree is always offered', () => {
    expect(commitActions(one, base).find(item => item.id === 'compareWorktree')?.disabledReason).toBeUndefined()
    expect(commitActionEffect('compareWorktree', one, null)).toEqual({
      kind: 'overlay', overlay: { kind: 'compare', left: one.sha, right: null, leftLabel: 'aaaaaaa', rightLabel: null },
    })
  })

  it('compare selected needs exactly two selected commits including this one', () => {
    expect(reasonOf([])).toBe('commit.disabled.compareNeedsTwo')
    expect(reasonOf([one.sha])).toBe('commit.disabled.compareNeedsTwo')
    expect(reasonOf([one.sha, two.sha])).toBeUndefined()
    expect(reasonOf([one.sha, two.sha, 'c'.repeat(40)])).toBe('commit.disabled.compareTooMany')
    expect(commitActionEffect('compareSelected', one, null, [one, two])).toEqual({
      kind: 'overlay', overlay: { kind: 'compare', left: one.sha, right: two.sha, leftLabel: 'aaaaaaa', rightLabel: 'bbbbbbb' },
    })
    expect(commitActionEffect('compareSelected', one, null, [one])).toBeNull()
  })
})

describe('B3a interactive rebase items', () => {
  // Log newest first: head → c3 → c2 → c1 → root.
  const sha = (letter: string): string => letter.repeat(40)
  const log: CommitSummary[] = [
    commit({ sha: sha('4'), shortSha: '4444444', parents: [sha('3')], subject: 'c4' }),
    commit({ sha: sha('3'), shortSha: '3333333', parents: [sha('2')], subject: 'c3' }),
    commit({ sha: sha('2'), shortSha: '2222222', parents: [sha('1')], subject: 'c2' }),
    commit({ sha: sha('1'), shortSha: '1111111', parents: [], subject: 'root' }),
  ]
  const at = (letter: string): CommitSummary => log.find(entry => entry.sha === sha(letter))!
  const contextFor = (letter: string, patch: { selection?: string[]; headSha?: string; rebase?: boolean; writable?: boolean } = {}) =>
    commitActionContext(log, at(letter), {
      writable: patch.writable ?? true,
      operation: null,
      selection: patch.selection ?? [sha(letter)],
      rebase: patch.rebase ?? true,
      headSha: patch.headSha ?? sha('4'),
    })
  const reasonOf = (items: ReturnType<typeof commitActions>, id: string): string | undefined => {
    const reason = find(items, id)?.disabledReason
    return reason === undefined ? undefined : render(zhT, reason)
  }

  it('adds the four rebase items after the P0 items when the flag is on, none when off', () => {
    const items = commitActions(at('3'), contextFor('3'))
    expect(items.map(item => item.id).slice(-4)).toEqual(['interactiveRebaseFrom', 'reword', 'drop', 'squashSelected'])
    expect(find(items, 'drop')?.danger).toBe(true)
    expect(commitActions(at('3'), contextFor('3', { rebase: false })).map(item => item.id)).not.toContain('reword')
  })

  it('enables the rebase items on the first-parent chain of HEAD, including the root', () => {
    for (const letter of ['4', '3', '1']) {
      const items = commitActions(at(letter), contextFor(letter))
      expect(reasonOf(items, 'interactiveRebaseFrom'), letter).toBeUndefined()
      expect(reasonOf(items, 'reword'), letter).toBeUndefined()
      expect(reasonOf(items, 'drop'), letter).toBeUndefined()
    }
  })

  it('disables them off the chain, on merge commits, read-only, and explains squash needs', () => {
    const other = commitActions(at('3'), contextFor('3', { headSha: sha('2') }))
    expect(reasonOf(other, 'reword')).toBe('这个提交不在当前分支上')
    const merge = commitActions(commit({ sha: sha('3'), parents: [sha('2'), sha('9')] }), { ...contextFor('3') })
    expect(reasonOf(merge, 'reword')).toBe('合并提交不能在这里变基')
    expect(reasonOf(commitActions(at('3'), contextFor('3', { writable: false })), 'reword')).toBeDefined()
    expect(reasonOf(commitActions(at('3'), contextFor('3')), 'squashSelected')).toBe('先选中当前分支上相邻的两个或更多提交')
  })

  it('treats a chain it cannot follow in the loaded log as possible (the Host decides)', () => {
    const items = commitActions(at('3'), contextFor('3', { headSha: sha('f') }))
    expect(reasonOf(items, 'reword')).toBeUndefined()
  })

  it('enables squash for adjacent selected commits on the chain only', () => {
    expect(reasonOf(commitActions(at('3'), contextFor('3', { selection: [sha('3'), sha('2')] })), 'squashSelected')).toBeUndefined()
    expect(reasonOf(commitActions(at('4'), contextFor('4', { selection: [sha('4'), sha('2')] })), 'squashSelected')).toBe('先选中当前分支上相邻的两个或更多提交')
  })

  it('runs a shortcut only when its item is present and enabled', () => {
    expect(enabledAction(commitActions(at('3'), contextFor('3')), 'reword')).toBe(true)
    expect(enabledAction(commitActions(at('3'), contextFor('3', { writable: false })), 'reword')).toBe(false)
    expect(enabledAction(commitActions(at('3'), contextFor('3', { rebase: false })), 'reword')).toBe(false)
  })

  it('opens the rebase page from the parent, with a preset for the quick actions', () => {
    expect(commitActionEffect('interactiveRebaseFrom', at('3'), null)).toEqual({ kind: 'overlay', overlay: { kind: 'interactiveRebase', base: sha('2') } })
    expect(commitActionEffect('interactiveRebaseFrom', at('1'), null)).toEqual({ kind: 'overlay', overlay: { kind: 'interactiveRebase', base: null } })
    expect(commitActionEffect('reword', at('3'), null)).toEqual({
      kind: 'overlay', overlay: { kind: 'interactiveRebase', base: sha('2'), preset: { kind: 'reword', sha: sha('3') } },
    })
    expect(commitActionEffect('drop', at('3'), null)).toEqual({
      kind: 'overlay', overlay: { kind: 'interactiveRebase', base: sha('2'), preset: { kind: 'drop', sha: sha('3') } },
    })
    // Selected newest first in the log: the base is the parent of the oldest selected commit.
    expect(commitActionEffect('squashSelected', at('3'), null, [at('3'), at('2')])).toEqual({
      kind: 'overlay', overlay: { kind: 'interactiveRebase', base: sha('1'), preset: { kind: 'squash', shas: [sha('3'), sha('2')] } },
    })
  })
})
