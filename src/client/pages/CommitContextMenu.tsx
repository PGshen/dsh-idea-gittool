// Right-click / Shift+F10 menu of a log row (design §8.1.7, plan A3 T8). Disabled items stay
// visible with their reason; dangerous items use the danger tone. Esc and outside clicks close it.
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { CommitSummary } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import type { CommitActionId, CommitActionItem } from './commit-actions.ts'
import css from './CommitContextMenu.module.css'
import { useMenuPlacement } from './menu-position.ts'
import type { MenuAnchor } from './menu-position.ts'

export interface CommitContextMenuProps {
  commit: CommitSummary
  items: CommitActionItem[]
  onSelect: (id: CommitActionId) => void
  onClose?: () => void
  /** Where it opens; measured after render and kept inside the viewport and the Git panel. Without it the menu renders in the document flow. */
  anchor?: MenuAnchor
}

export function CommitContextMenu({ commit, items, onSelect, onClose, anchor }: CommitContextMenuProps): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  // The parent re-renders (log refresh) with a new onClose each time; the listener must not re-arm.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const closable = onClose !== undefined
  const style = useMenuPlacement(ref, anchor)
  useEffect(() => {
    if (!closable) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return
      closeRef.current?.()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [closable])

  const moveFocus = (step: 1 | -1): void => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (nodes.length === 0) return
    const index = nodes.findIndex(node => node === document.activeElement)
    nodes[(index + step + nodes.length) % nodes.length]?.focus()
  }

  const nodes: ReactNode[] = []
  let previousSection: number | null = null
  for (const item of items) {
    if (previousSection !== null && item.section !== previousSection) {
      nodes.push(<div key={`sep-${item.id}`} role="separator" className={css.separator} />)
    }
    previousSection = item.section
    const reason = item.disabledReason === undefined ? null : t(item.disabledReason.key, item.disabledReason.params)
    nodes.push(
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className={`${css.item} ${reason === null ? '' : css.itemDisabled}`}
        data-action={item.id}
        {...(item.danger === true ? { 'data-danger': true } : {})}
        {...(reason === null ? {} : { 'aria-disabled': true, title: reason })}
        onClick={() => { if (reason === null) onSelect(item.id) }}
      >
        <span>{t(item.label.key, item.label.params)}</span>
        {reason === null ? null : <span className={css.reason}>{reason}</span>}
      </button>,
    )
  }
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('commit.menu', { sha: commit.shortSha })}
      className={`${css.menu} ${anchor === undefined ? '' : css.floating}`}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current?.()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      {nodes}
    </div>
  )
}
