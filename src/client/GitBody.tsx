// Git tab 的正文：bootstrap 快照 + 只读横幅 + 提交/文件摘要。
// M0 只验证数据通路与刷新；提交图、diff、筛选等属于 A1/A2。
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapCache } from './bootstrap-cache.ts'
import { createPoller } from './polling.ts'
import { ReadOnlyBanner } from './read-only-banner.tsx'
import { useBootstrap } from './use-bootstrap.ts'

export interface GitBodyInjected {
  bootstrapCache: BootstrapCache
}

const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  height: '100%',
  boxSizing: 'border-box',
  overflow: 'auto',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '12px',
}

const MUTED: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }

const MONO: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, monospace)',
  fontSize: '11px',
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }

const BUTTON: CSSProperties = {
  marginLeft: 'auto',
  padding: '0 6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '4px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  cursor: 'pointer',
}

export function GitBody(props: PropsRuntime<'sidebar.right.pane.tab'> & GitBodyInjected): ReactNode {
  const { sessionId, useTabInfo, useSessions, bootstrapCache } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const { tab } = useTabInfo()
  const visible = tab.visible
  const value = useBootstrap(bootstrapCache, sessionId)
  const failure = bootstrapCache.getFailure(sessionId)

  useEffect(() => {
    const poller = createPoller({
      isVisible: () => visible,
      refresh: () => bootstrapCache.refresh(sessionId).then(version => ({ version })),
    })
    poller.start()
    return () => poller.stop()
  }, [bootstrapCache, sessionId, visible])

  if (value === null) {
    return (
      <div style={PANEL}>
        {failure === null
          ? <span style={MUTED}>读取中…</span>
          : <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{failure.code}：{failure.message}</span>}
        {cwd === undefined ? null : <span style={MONO}>{cwd}</span>}
      </div>
    )
  }

  const status = value.status
  return (
    <div style={PANEL}>
      <ReadOnlyBanner policy={value.writePolicy} />
      <div style={ROW}>
        <strong>{status?.branch ?? (status?.detached === true ? `detached@${status.head?.slice(0, 7) ?? '?'}` : '（无分支）')}</strong>
        {status === null || status.upstream === null ? null : <span style={MUTED}>{status.upstream}</span>}
        {status === null || (status.ahead === 0 && status.behind === 0)
          ? null
          : <span style={MUTED}>↑{status.ahead} ↓{status.behind}</span>}
        <button type="button" style={BUTTON} onClick={() => { void bootstrapCache.refresh(sessionId) }}>刷新</button>
      </div>
      <span style={MONO}>{value.repoRoot ?? '当前会话目录不在 Git 仓库中'}</span>
      {value.repoRoot === null
        ? <span style={MUTED}>在仓库里打开会话后，这里会显示提交与工作区状态。</span>
        : null}
      {status === null || value.repoRoot === null ? null : (
        <>
          {status.conflicts.length > 0
            ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>冲突 {status.conflicts.length} 个文件</span>
            : null}
          <span style={MUTED}>
            已暂存 {status.staged.length} · 未暂存 {status.unstaged.length} · 未跟踪 {status.untracked.length}
          </span>
        </>
      )}
      {value.log === null || value.log.commits.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
          {value.log.commits.slice(0, 20).map(commit => (
            <div key={commit.sha} style={{ display: 'flex', gap: '6px', alignItems: 'baseline' }}>
              <span style={{ ...MONO, color: 'var(--dsw-alias-label-tertiary)' }}>{commit.shortSha}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{commit.subject}</span>
              <span style={{ ...MUTED, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{commit.author}</span>
            </div>
          ))}
        </div>
      )}
      <span style={{ ...MUTED, marginTop: 'auto' }}>version {value.version} · 可见时每 3s 刷新</span>
    </div>
  )
}
