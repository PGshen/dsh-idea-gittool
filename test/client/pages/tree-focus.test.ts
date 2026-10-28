// B4b T4: roving tabindex model shared by the branch trees (BranchPanel, BranchesPage).
import { describe, expect, it } from 'vitest'
import { moveFocus, tabStop, treeRowsFromLevels } from '../../../src/client/pages/tree-focus.ts'
import type { TreeRow } from '../../../src/client/pages/tree-focus.ts'

// local (expanded) > feature (expanded dir) > feature/a ; local > main ; remote (collapsed)
const rows: TreeRow[] = treeRowsFromLevels([
  { id: 'g:local', level: 1, expanded: true },
  { id: 'dir:feature', level: 2, expanded: true },
  { id: 'feature/a', level: 3, expanded: null },
  { id: 'main', level: 2, expanded: null },
  { id: 'g:remote', level: 1, expanded: false },
])

describe('treeRowsFromLevels', () => {
  it('derives each parent from the nearest previous row one level up', () => {
    expect(rows.map(row => [row.id, row.parentId, row.expandable])).toEqual([
      ['g:local', null, true],
      ['dir:feature', 'g:local', true],
      ['feature/a', 'dir:feature', false],
      ['main', 'g:local', false],
      ['g:remote', null, true],
    ])
  })
})

describe('tabStop', () => {
  it('prefers the last focused row, then the selected row, then the first row', () => {
    expect(tabStop(rows, 'main', 'feature/a')).toBe('feature/a')
    expect(tabStop(rows, 'main', null)).toBe('main')
    expect(tabStop(rows, 'main', 'gone')).toBe('main')
    expect(tabStop(rows, 'gone', 'also-gone')).toBe('g:local')
    expect(tabStop([], 'main', null)).toBeNull()
  })
})

describe('moveFocus', () => {
  it.each([
    ['g:local', 'ArrowDown', { focus: 'dir:feature' }],
    ['g:remote', 'ArrowDown', null],
    ['g:local', 'ArrowUp', null],
    ['main', 'ArrowUp', { focus: 'feature/a' }],
    ['main', 'Home', { focus: 'g:local' }],
    ['g:local', 'End', { focus: 'g:remote' }],
    ['g:remote', 'ArrowRight', { toggle: 'g:remote' }],
    ['dir:feature', 'ArrowRight', { focus: 'feature/a' }],
    ['main', 'ArrowRight', null],
    ['dir:feature', 'ArrowLeft', { toggle: 'dir:feature' }],
    ['feature/a', 'ArrowLeft', { focus: 'dir:feature' }],
    ['main', 'ArrowLeft', { focus: 'g:local' }],
    ['g:remote', 'ArrowLeft', null],
  ] as const)('%s + %s', (current, key, expected) => {
    expect(moveFocus(rows, current, key)).toEqual(expected)
  })

  it('an expanded node without visible children does not move on ArrowRight', () => {
    const empty = treeRowsFromLevels([{ id: 'g:tags', level: 1, expanded: true }, { id: 'g:x', level: 1, expanded: false }])
    expect(moveFocus(empty, 'g:tags', 'ArrowRight')).toBeNull()
  })

  it('unknown current row moves nowhere', () => {
    expect(moveFocus(rows, 'missing', 'ArrowDown')).toBeNull()
  })
})
