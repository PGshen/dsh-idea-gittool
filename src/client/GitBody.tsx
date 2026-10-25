// Git tab 的正文。M0 T2 只建立挂载与空态；T3 之后接 bootstrap 数据。
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px',
  height: '100%',
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '12px',
} as const

const mutedStyle = { color: 'var(--dsw-alias-label-tertiary)' } as const

export function GitBody({ sessionId, useSessions }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  return (
    <div style={panelStyle}>
      <strong>Git</strong>
      <div style={mutedStyle}>{cwd ?? '这个会话没有工作目录。'}</div>
      <div style={mutedStyle}>M0 集成 spike：RPC 数据接入中。</div>
    </div>
  )
}
