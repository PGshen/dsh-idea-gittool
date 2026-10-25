// 只读横幅：写能力门禁判定为 read-only 时，在 Git 面板顶部说明原因并隐含禁用写按钮。
// 样式只用 DSH 主题语义 token（docs/web-styling.md / 可行性调研 §4.2）。
import type { ReactNode } from 'react'
import type { WritePolicyValue } from '../shared/protocol.ts'
import css from './read-only-banner.module.css'

export interface ReadOnlyBannerProps {
  policy: WritePolicyValue
  /** Optional localized message; falls back to the Host-provided reason. */
  message?: string
}

export function ReadOnlyBanner({ policy, message }: ReadOnlyBannerProps): ReactNode {
  if (policy.mode === 'read-write') return null
  return (
    <div role="status" aria-live="polite" data-dsh-git-read-only="" className={css.banner}>
      <strong className={css.title}>只读模式</strong>
      <span>{message ?? policy.reason ?? '当前仓库不在可写沙箱范围内，写操作已禁用'}</span>
    </div>
  )
}
