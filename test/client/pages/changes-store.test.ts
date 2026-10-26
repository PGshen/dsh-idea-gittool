// T4 changes store: grouping/sorting, tri-state checks, refresh keep/drop, search, badge de-dup.
import { describe, expect, it } from 'vitest'
import {
  CHANGE_GROUP_ORDER,
  buildChangeGroups,
  collectChanges,
  createChangesStore,
  uncommittedCount,
} from '../../../src/client/store/changes-store.ts'
import type { ChangeTreeNode } from '../../../src/client/store/changes-store.ts'
import { entry, mixedStatus, statusFixture } from './changes-fixtures.ts'

function filePaths(nodes: readonly ChangeTreeNode[]): string[] {
  return nodes.flatMap(node => (node.kind === 'file' ? [node.entry.path] : filePaths(node.children)))
}

describe('collectChanges', () => {
  it('de-duplicates by path and orders groups conflicts → modified → added → deleted → renamed → untracked', () => {
    const changes = collectChanges(mixedStatus())
    expect(changes.map(change => change.path)).toEqual([
      'src/merge.ts',
      'README.md',
      'src/both.ts',
      'src/client/log/LogTable.tsx',
      'src/client/new.ts',
      'src/gone.ts',
      'docs/renamed.md',
      'scratch.md',
    ])
    expect(changes.map(change => change.group)).toEqual([
      'conflicts', 'modified', 'modified', 'modified', 'added', 'deleted', 'renamed', 'untracked',
    ])
    expect(CHANGE_GROUP_ORDER).toEqual(['conflicts', 'modified', 'added', 'deleted', 'renamed', 'untracked'])
  })

  it('merges staged + unstaged entries of one path (counts summed, worktree diff preferred)', () => {
    const both = collectChanges(mixedStatus()).find(change => change.path === 'src/both.ts')
    expect(both).toMatchObject({ staged: true, unstaged: true, additions: 3, deletions: 1, diffScope: 'worktree' })
    const stagedOnly = collectChanges(mixedStatus()).find(change => change.path === 'src/client/new.ts')
    expect(stagedOnly).toMatchObject({ staged: true, unstaged: false, diffScope: 'staged', status: 'A' })
  })

  it('a staged add later modified in the worktree stays in the added group', () => {
    const changes = collectChanges(statusFixture({
      staged: [entry('a.ts', 'A')],
      unstaged: [entry('a.ts', 'M')],
    }))
    expect(changes[0]).toMatchObject({ group: 'added', status: 'A' })
  })

  it('untracked entries carry no line counts', () => {
    const changes = collectChanges(statusFixture({ untracked: [entry('x.txt', '?', { additions: 4 })] }))
    expect(changes[0]?.additions).toBeUndefined()
  })

  it('returns [] for null status', () => {
    expect(collectChanges(null)).toEqual([])
  })

  it('sorts paths naturally inside a group', () => {
    const changes = collectChanges(statusFixture({
      unstaged: [entry('f10.ts', 'M'), entry('f2.ts', 'M'), entry('F1.ts', 'M')],
    }))
    expect(changes.map(change => change.path)).toEqual(['F1.ts', 'f2.ts', 'f10.ts'])
  })
})

describe('uncommittedCount (tab badge)', () => {
  it('counts conflicts + staged + unstaged + untracked de-duplicated by path', () => {
    expect(uncommittedCount(mixedStatus())).toBe(8)
    expect(uncommittedCount(statusFixture())).toBe(0)
    expect(uncommittedCount(null)).toBe(0)
  })
})

describe('buildChangeGroups', () => {
  it('builds directory trees per group, directories first, compacting single-child chains', () => {
    const groups = buildChangeGroups(collectChanges(mixedStatus()), { checked: new Set() })
    expect(groups.map(group => group.kind)).toEqual(CHANGE_GROUP_ORDER)
    const modified = groups.find(group => group.kind === 'modified')
    expect(modified?.count).toBe(3)
    const [first, second] = modified?.nodes ?? []
    expect(first).toMatchObject({ kind: 'dir', name: 'src', path: 'src' })
    expect(second).toMatchObject({ kind: 'file', name: 'README.md' })
    if (first?.kind !== 'dir') throw new Error('expected dir')
    expect(first.children.map(node => node.name)).toEqual(['client/log', 'both.ts'])
  })

  it('omits empty groups', () => {
    const groups = buildChangeGroups(collectChanges(statusFixture({ untracked: [entry('a', '?')] })), { checked: new Set() })
    expect(groups.map(group => group.kind)).toEqual(['untracked'])
  })

  it('search filters display only (path and original path, case-insensitive)', () => {
    const changes = collectChanges(mixedStatus())
    const groups = buildChangeGroups(changes, { checked: new Set(), search: 'LOG' })
    expect(groups.flatMap(group => filePaths(group.nodes))).toEqual(['src/client/log/LogTable.tsx'])
    const renamed = buildChangeGroups(changes, { checked: new Set(), search: 'old.md' })
    expect(renamed.flatMap(group => filePaths(group.nodes))).toEqual(['docs/renamed.md'])
  })

  it('collapsed groups and dirs keep their count but hide children', () => {
    const changes = collectChanges(mixedStatus())
    const groups = buildChangeGroups(changes, { checked: new Set(), collapsed: { 'g:modified': true, 'd:added:src/client': true } })
    const modified = groups.find(group => group.kind === 'modified')
    expect(modified).toMatchObject({ collapsed: true, count: 3, nodes: [] })
    const added = groups.find(group => group.kind === 'added')
    expect(added?.nodes[0]).toMatchObject({ kind: 'dir', collapsed: true, count: 1, children: [] })
  })

  it('marks conflict rows disabled and keeps them out of tri-state', () => {
    const groups = buildChangeGroups(collectChanges(mixedStatus()), { checked: new Set() })
    const conflicts = groups[0]
    expect(conflicts?.check).toBe('none')
    expect(conflicts?.checkable).toBe(false)
    const row = conflicts?.nodes[0]
    if (row?.kind !== 'dir') throw new Error('expected dir')
    expect(row.children[0]).toMatchObject({ kind: 'file', disabled: true })
  })
})

describe('createChangesStore', () => {
  it('first status checks tracked non-conflict files by default; later new paths stay unchecked', () => {
    const store = createChangesStore()
    store.setStatus(mixedStatus())
    expect(store.getCheckedPaths()).toEqual([
      'README.md', 'src/both.ts', 'src/client/log/LogTable.tsx', 'src/client/new.ts', 'src/gone.ts', 'docs/renamed.md',
    ])
    store.setStatus(mixedStatus({ version: 2, untracked: [entry('scratch.md', '?'), entry('late.ts', '?')], unstaged: [entry('src/fresh.ts', 'M')] }))
    expect(store.getCheckedPaths()).not.toContain('src/fresh.ts')
  })

  it('initialChecked: none starts empty', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    expect(store.getCheckedPaths()).toEqual([])
  })

  it('refresh keeps checks for paths that still exist and drops vanished ones', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    store.setChecked(['README.md', 'src/gone.ts', 'scratch.md'], true)
    store.setStatus(mixedStatus({
      version: 2,
      unstaged: [entry('README.md', 'M')],
      untracked: [entry('scratch.md', '?')],
    }))
    expect(store.getCheckedPaths()).toEqual(['README.md', 'scratch.md'])
  })

  it('drops responses older than the adopted version', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus({ version: 5 }))
    store.setStatus(statusFixture({ version: 4 }))
    expect(store.getState().entries).toHaveLength(8)
  })

  it('conflict files cannot be checked', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    store.toggleFile('src/merge.ts')
    store.setChecked(['src/merge.ts'], true)
    store.checkOnly('src/merge.ts')
    expect(store.getCheckedPaths()).toEqual([])
  })

  it('directory toggles are tri-state: some → all → none', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    store.toggleFile('src/both.ts')
    const groupsOf = () => buildChangeGroups(store.getState().entries, store.getState())
    const srcDir = () => groupsOf().find(group => group.kind === 'modified')?.nodes[0]
    expect(srcDir()).toMatchObject({ kind: 'dir', check: 'some' })
    store.toggleNode('d:modified:src')
    expect(srcDir()).toMatchObject({ check: 'all' })
    expect(store.getCheckedPaths()).toEqual(['src/both.ts', 'src/client/log/LogTable.tsx'])
    store.toggleNode('d:modified:src')
    expect(srcDir()).toMatchObject({ check: 'none' })
    store.toggleNode('g:modified')
    expect(groupsOf().find(group => group.kind === 'modified')?.check).toBe('all')
    expect(store.getCheckedPaths()).toHaveLength(3)
  })

  it('search does not change checks; node toggles while searching only touch visible files', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    store.toggleFile('README.md')
    store.setSearch('log')
    expect(store.getCheckedPaths()).toEqual(['README.md'])
    store.toggleNode('g:modified')
    expect(store.getCheckedPaths()).toEqual(['README.md', 'src/client/log/LogTable.tsx'])
    store.setSearch('')
    expect(store.getCheckedPaths()).toEqual(['README.md', 'src/client/log/LogTable.tsx'])
  })

  it('checkAll toggles every visible checkable file; checkOnly and uncheck', () => {
    const store = createChangesStore({ initialChecked: 'none' })
    store.setStatus(mixedStatus())
    store.checkAll(true)
    expect(store.getCheckedPaths()).toHaveLength(7)
    store.checkOnly('scratch.md')
    expect(store.getCheckedPaths()).toEqual(['scratch.md'])
    store.checkAll(true)
    store.uncheck(['README.md', 'scratch.md'])
    expect(store.getCheckedPaths()).not.toContain('README.md')
    store.checkAll(false)
    expect(store.getCheckedPaths()).toEqual([])
  })

  it('collapse, focus and subscription', () => {
    const store = createChangesStore()
    let calls = 0
    const off = store.subscribe(() => { calls += 1 })
    const initial = calls
    store.toggleCollapsed('g:modified')
    expect(store.getState().collapsed['g:modified']).toBe(true)
    store.toggleCollapsed('g:modified')
    expect(store.getState().collapsed['g:modified']).toBeUndefined()
    store.setFocused('README.md')
    expect(store.getState().focused).toBe('README.md')
    expect(calls).toBe(initial + 3)
    off()
    store.setFocused(null)
    expect(calls).toBe(initial + 3)
  })

  it('focus on a vanished path is cleared on refresh', () => {
    const store = createChangesStore()
    store.setStatus(mixedStatus())
    store.setFocused('src/gone.ts')
    store.setStatus(mixedStatus({ version: 2, unstaged: [] }))
    expect(store.getState().focused).toBeNull()
  })
})
