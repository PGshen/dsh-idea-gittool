// Right-click / Shift+F10 menu of a log row (design §8.1.7, plan A3 T8). Disabled items stay
// visible with their reason; dangerous items use the danger tone. Esc / ArrowLeft and outside clicks
// close it; focus lands on the first enabled item once the menu is placed (I-1).
import { useRef } from 'react'
import type { ReactNode } from 'react'
import type { CommitSummary } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import type { CommitActionId, CommitActionItem } from './commit-actions.ts'
import css from './CommitContextMenu.module.css'
import { useFloatingMenu } from './menu-position.ts'
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
  // Placement, focus once placed, arrow keys and closing (the parent's onClose may change every render).
  const { style, onKeyDown } = useFloatingMenu(ref, anchor, onClose)

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
      onKeyDown={onKeyDown}
    >
      {nodes}
    </div>
  )
}
