// refs / 筛选条件胶囊。kind 决定语义色，全部来自 --dsw-* token。
import type { ReactNode } from 'react'
import css from './Chip.module.css'

export type ChipKind = 'local' | 'remote' | 'tag' | 'head' | 'filter' | 'count'

export interface ChipProps {
  kind?: ChipKind
  title?: string
  onClick?: () => void
  children: ReactNode
}

const KIND_CLASS: Record<ChipKind, string> = {
  local: css.local ?? '',
  remote: css.remote ?? '',
  tag: css.tag ?? '',
  head: css.head ?? '',
  filter: css.filter ?? '',
  count: css.count ?? '',
}

export function Chip({ kind = 'local', title, onClick, children }: ChipProps): ReactNode {
  const className = [css.chip, KIND_CLASS[kind]].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  if (onClick === undefined) {
    return <span className={className} title={title}>{children}</span>
  }
  return <button type="button" className={className} title={title} onClick={onClick}>{children}</button>
}
