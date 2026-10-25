// 文件状态字母：M/A/D/R/C/T/U/?，颜色只来自语义 token。
import type { ReactNode } from 'react'
import type { FileStatusCode } from '../../shared/protocol.ts'
import css from './StatusLetter.module.css'

export interface StatusLetterProps {
  status: FileStatusCode
  title?: string
}

const CLASS: Record<FileStatusCode, string> = {
  M: css.modified ?? '',
  A: css.added ?? '',
  D: css.deleted ?? '',
  R: css.renamed ?? '',
  C: css.renamed ?? '',
  T: css.typeChanged ?? '',
  U: css.conflicted ?? '',
  '?': css.untracked ?? '',
}

export function StatusLetter({ status, title }: StatusLetterProps): ReactNode {
  return (
    <span
      className={[css.letter, CLASS[status]].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')}
      title={title ?? status}
      data-status={status}
    >
      {status}
    </span>
  )
}
