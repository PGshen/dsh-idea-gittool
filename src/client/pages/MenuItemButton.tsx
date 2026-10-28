// One menu item (B4b T5), shared by the commit/branch/conflict/action menus. An unavailable item
// stays focusable (aria-disabled) and visible with its reason; the label names it and the reason
// describes it, so a screen reader announces "Merge, dimmed, <reason>" instead of one long name.
import { useId } from 'react'
import type { ReactNode } from 'react'

export interface MenuItemButtonProps {
  label: string
  /** Why the item is unavailable; null when it can be chosen. */
  reason: string | null
  danger?: boolean
  className: string | undefined
  disabledClassName: string | undefined
  reasonClassName: string | undefined
  /** Extra `data-*` attributes (tests and styles select items by them). */
  data?: Readonly<Record<`data-${string}`, string>>
  onSelect: () => void
}

export function MenuItemButton({ label, reason, danger, className, disabledClassName, reasonClassName, data, onSelect }: MenuItemButtonProps): ReactNode {
  const id = useId()
  const labelId = `${id}-label`
  const reasonId = `${id}-reason`
  return (
    <button
      type="button"
      role="menuitem"
      className={`${className ?? ''} ${reason === null ? '' : (disabledClassName ?? '')}`}
      aria-labelledby={labelId}
      {...data}
      {...(danger === true ? { 'data-danger': true } : {})}
      {...(reason === null ? {} : { 'aria-disabled': true, 'aria-describedby': reasonId, title: reason })}
      onClick={() => { if (reason === null) onSelect() }}
    >
      <span id={labelId}>{label}</span>
      {reason === null ? null : <span id={reasonId} className={reasonClassName}>{reason}</span>}
    </button>
  )
}
