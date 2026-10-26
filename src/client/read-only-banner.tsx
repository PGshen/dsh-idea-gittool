// 只读横幅：写能力门禁判定为 read-only 时，在 Git 面板顶部说明原因并隐含禁用写按钮。
// 样式只用 DSH 主题语义 token（docs/web-styling.md / 可行性调研 §4.2）。
import type { ReactNode } from 'react'
import type { WritePolicyValue } from '../shared/protocol.ts'
import { useT } from './i18n.tsx'
import { readOnlyMessage } from './localized-text.ts'
import css from './read-only-banner.module.css'

export interface ReadOnlyBannerProps {
  policy: WritePolicyValue
  /** Optional localized message; overrides the reason derived from the policy. */
  message?: string
}

export function ReadOnlyBanner({ policy, message }: ReadOnlyBannerProps): ReactNode {
  const t = useT()
  const reason = readOnlyMessage(t, policy)
  if (reason === null) return null
  return (
    <div role="status" aria-live="polite" data-dsh-git-read-only="" className={css.banner}>
      <strong className={css.title}>{t('readOnly.title')}</strong>
      <span>{message ?? reason}</span>
    </div>
  )
}
