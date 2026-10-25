// 空态 / 错误态：标题 + 一句说明 + 可选动作。
import type { ReactNode } from 'react'
import { Button } from './Button.tsx'
import css from './EmptyState.module.css'

export interface EmptyStateProps {
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
  error?: boolean
}

export function EmptyState({ title, hint, action, error = false }: EmptyStateProps): ReactNode {
  return (
    <div className={error ? `${css.empty} ${css.error}` : css.empty} role={error ? 'alert' : undefined}>
      <strong className={css.title}>{title}</strong>
      {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
      {action === undefined ? null : <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
