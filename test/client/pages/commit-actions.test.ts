// A3 T8 commit context menu: availability matrix and what each item does.
import { describe, expect, it } from 'vitest'
import {
  childOf,
  commitActionContext,
  commitActionEffect,
  commitActions,
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
