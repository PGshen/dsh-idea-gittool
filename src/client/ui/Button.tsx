// 基础按钮：primary / ghost / danger 三种语气，尺寸只做 A1 需要的一档。
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import css from './Button.module.css'

export type ButtonTone = 'primary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone
  children: ReactNode
}

const TONE_CLASS: Record<ButtonTone, string> = {
  primary: css.primary ?? '',
  ghost: css.ghost ?? '',
  danger: css.danger ?? '',
}

export function Button({ tone = 'ghost', className, type = 'button', children, ...rest }: ButtonProps): ReactNode {
  const classes = [css.button, TONE_CLASS[tone], className].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  )
}
