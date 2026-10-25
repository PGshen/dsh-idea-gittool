// 只读横幅：写能力门禁判定为 read-only 时，在 Git 面板顶部说明原因并隐含禁用写按钮。
// M0 T4 只交付组件；接线（client/index.ts 或 GitBody）由 Lead 在 T2 集成时做。
// 样式只用 DSH 主题语义 token（docs/web-styling.md / 可行性调研 §4.2），不写字面色。

import type { CSSProperties, ReactElement } from 'react'

import type { WritePolicyValue } from '../shared/protocol.ts'

/** Props for {@link ReadOnlyBanner}; `policy` comes from `BootstrapValue.writePolicy`. */
export interface ReadOnlyBannerProps {
  policy: WritePolicyValue
  /** Optional localized message; falls back to the Host-provided reason. */
  message?: string
}

const CONTAINER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  padding: '6px 10px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  borderLeft: '2px solid var(--dsw-alias-state-warn)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 'var(--dsw-alias-font-size-caption, 12px)',
  lineHeight: 1.5,
}

const TITLE_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

/** Renders nothing when writes are allowed; otherwise a blocking read-only explanation. */
export function ReadOnlyBanner({ policy, message }: ReadOnlyBannerProps): ReactElement | null {
  if (policy.mode === 'read-write') return null
  return (
    <div role="status" aria-live="polite" data-dsh-git-read-only="" style={CONTAINER_STYLE}>
      <strong style={TITLE_STYLE}>只读模式</strong>
      <span>{message ?? policy.reason ?? '当前仓库不在可写沙箱范围内，写操作已禁用'}</span>
    </div>
  )
}
