// React side of tree-focus (B4b T4): tracks the Tab stop and handles navigation keys for a
// `role="tree"` container whose rows carry `data-tree-id` and `aria-level`.
import { useCallback, useState } from 'react'
import type { FocusEvent, KeyboardEvent } from 'react'
import { TREE_FOCUS_KEYS, moveFocus, tabStop, treeRowsFromLevels } from './tree-focus.ts'
import type { TreeFocusKey } from './tree-focus.ts'

const TREE_ITEM = '[role="treeitem"][data-tree-id]'

export interface TreeRoving {
  /** `0` for the one Tab stop, `-1` for every other row. */
  tabIndexOf: (id: string) => 0 | -1
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

function itemsOf(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(TREE_ITEM)]
}

/** `ids`: every visible row in display order; `selectedId`: the selected row, if any. */
export function useTreeRoving(ids: readonly string[], selectedId: string | null): TreeRoving {
  const [previous, setPrevious] = useState<string | null>(null)
  const stop = tabStop(ids.map(id => ({ id })), selectedId, previous)

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const id = event.target instanceof HTMLElement && event.target.matches(TREE_ITEM) ? event.target.dataset.treeId : undefined
    if (id !== undefined) setPrevious(id)
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !TREE_FOCUS_KEYS.has(event.key)) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches(TREE_ITEM)) return
    const items = itemsOf(event.currentTarget)
    const rows = treeRowsFromLevels(items.map(item => {
      const expanded = item.getAttribute('aria-expanded')
      return { id: item.dataset.treeId ?? '', level: Number(item.getAttribute('aria-level') ?? 1), expanded: expanded === null ? null : expanded === 'true' }
    }))
    const result = moveFocus(rows, target.dataset.treeId ?? '', event.key as TreeFocusKey)
    if (result === null) return
    event.preventDefault()
    const id = 'focus' in result ? result.focus : result.toggle
    const element = items.find(item => item.dataset.treeId === id)
    if ('focus' in result) element?.focus()
    else element?.click()
  }, [])

  return { tabIndexOf: id => (id === stop ? 0 : -1), onFocus, onKeyDown }
}
