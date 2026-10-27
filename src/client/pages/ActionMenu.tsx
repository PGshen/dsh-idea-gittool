// Generic floating action menu (B2): the commit context menu's markup and behaviour for any list of
// items — blame segments, file rows. Disabled items stay visible with their reason; Esc / ArrowLeft and
// outside clicks close it; focus lands on the first enabled item once placed.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import css from './CommitContextMenu.module.css'
import { useFloatingMenu } from './menu-position.ts'
import type { MenuAnchor } from './menu-position.ts'

export interface ActionMenuItem<Id extends string> {
  id: Id
  label: LocalizedText
  danger?: boolean
  disabledReason?: LocalizedText
  /** Menu section; a separator is drawn between sections. */
  section: number
}

export interface ActionMenuProps<Id extends string> {
  /** Accessible name of the menu. */
  label: string
  items: readonly ActionMenuItem<Id>[]
  onSelect: (id: Id) => void
  onClose?: () => void
  /** Where it opens; without it the menu renders in the document flow. */
  anchor?: MenuAnchor
}

export function ActionMenu<Id extends string>({ label, items, onSelect, onClose, anchor }: ActionMenuProps<Id>): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
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
      aria-label={label}
      className={`${css.menu} ${anchor === undefined ? '' : css.floating}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      {nodes}
    </div>
  )
}
