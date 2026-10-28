// Roving tabindex for the branch trees (B4b T4, WAI-ARIA tree pattern): one Tab stop per tree,
// ↑↓ Home End move between visible rows, → expands / enters the first child, ← collapses / goes
// to the parent. Pure: the components build rows from what they render.

export interface TreeRow {
  id: string
  parentId: string | null
  expandable: boolean
  expanded: boolean
}

export type TreeFocusKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export const TREE_FOCUS_KEYS: ReadonlySet<string> = new Set<TreeFocusKey>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** Rows in display order from their levels (1 = top); `expanded: null` marks a leaf. */
export function treeRowsFromLevels(items: ReadonlyArray<{ id: string; level: number; expanded: boolean | null }>): TreeRow[] {
  const ancestors: Array<{ id: string; level: number }> = []
  return items.map(item => {
    while (ancestors.length > 0 && (ancestors[ancestors.length - 1]?.level ?? 0) >= item.level) ancestors.pop()
    const parent = ancestors[ancestors.length - 1]
    ancestors.push({ id: item.id, level: item.level })
    return {
      id: item.id,
      parentId: parent !== undefined && parent.level === item.level - 1 ? parent.id : null,
      expandable: item.expanded !== null,
      expanded: item.expanded === true,
    }
  })
}

/**
 * The row that carries `tabIndex=0`: the last focused row (so the stop follows arrow keys), else
 * the selected row, else the first. Rows that disappeared (refresh, collapse) are skipped.
 */
export function tabStop(rows: ReadonlyArray<Pick<TreeRow, 'id'>>, selectedId: string | null, previousStop: string | null): string | null {
  const has = (id: string | null): id is string => id !== null && rows.some(row => row.id === id)
  if (has(previousStop)) return previousStop
  if (has(selectedId)) return selectedId
  return rows[0]?.id ?? null
}

export function moveFocus(rows: readonly TreeRow[], currentId: string, key: TreeFocusKey): { focus: string } | { toggle: string } | null {
  const index = rows.findIndex(row => row.id === currentId)
  const row = rows[index]
  if (row === undefined) return null
  const focusAt = (target: number): { focus: string } | null => {
    const next = rows[target]
    return next === undefined || target === index ? null : { focus: next.id }
  }
  switch (key) {
    case 'ArrowDown': return focusAt(Math.min(index + 1, rows.length - 1))
    case 'ArrowUp': return focusAt(Math.max(index - 1, 0))
    case 'Home': return focusAt(0)
    case 'End': return focusAt(rows.length - 1)
    case 'ArrowRight':
      if (!row.expandable) return null
      if (!row.expanded) return { toggle: row.id }
      return rows[index + 1]?.parentId === row.id ? focusAt(index + 1) : null
    case 'ArrowLeft':
      if (row.expandable && row.expanded) return { toggle: row.id }
      return row.parentId === null ? null : { focus: row.parentId }
  }
}
