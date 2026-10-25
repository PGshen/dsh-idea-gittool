// Git tab 的正文：bootstrap 快照 + 只读横幅 + 提交/文件摘要。
// M0 只验证数据通路与刷新；提交图、diff、筛选等属于 A1/A2。
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapCache } from './bootstrap-cache.ts'
import css from './GitBody.module.css'
import { createPoller } from './polling.ts'
import { ReadOnlyBanner } from './read-only-banner.tsx'
import { useBootstrap } from './use-bootstrap.ts'

export interface GitBodyInjected {
  bootstrapCache: BootstrapCache
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
      <div className={css.panel}>
        {failure === null
          ? <span className={css.muted}>读取中…</span>
          : <span className={css.error}>{failure.code}：{failure.message}</span>}
        {cwd === undefined ? null : <span className={css.mono}>{cwd}</span>}
      </div>
    )
  }

  const status = value.status
  return (
    <div className={css.panel}>
      <ReadOnlyBanner policy={value.writePolicy} />
      <div className={css.row}>
        <strong>{status?.branch ?? (status?.detached === true ? `detached@${status.head?.slice(0, 7) ?? '?'}` : '（无分支）')}</strong>
        {status === null || status.upstream === null ? null : <span className={css.muted}>{status.upstream}</span>}
        {status === null || (status.ahead === 0 && status.behind === 0)
          ? null
          : <span className={css.muted}>↑{status.ahead} ↓{status.behind}</span>}
        <button type="button" className={css.refresh} onClick={() => { void bootstrapCache.refresh(sessionId) }}>刷新</button>
      </div>
      <span className={css.mono}>{value.repoRoot ?? '当前会话目录不在 Git 仓库中'}</span>
      {value.repoRoot === null
        ? <span className={css.muted}>在仓库里打开会话后，这里会显示提交与工作区状态。</span>
        : null}
      {status === null || value.repoRoot === null ? null : (
        <>
          {status.conflicts.length > 0
            ? <span className={css.error}>冲突 {status.conflicts.length} 个文件</span>
            : null}
          <span className={css.muted}>
            已暂存 {status.staged.length} · 未暂存 {status.unstaged.length} · 未跟踪 {status.untracked.length}
          </span>
        </>
      )}
      {value.log === null || value.log.commits.length === 0 ? null : (
        <div className={css.commits}>
          {value.log.commits.slice(0, 20).map(commit => (
            <div key={commit.sha} className={css.commitRow}>
              <span className={`${css.mono} ${css.commitSha}`}>{commit.shortSha}</span>
              <span className={css.commitSubject}>{commit.subject}</span>
              <span className={`${css.muted} ${css.commitAuthor}`}>{commit.author}</span>
            </div>
          ))}
        </div>
      )}
      <span className={`${css.muted} ${css.footer}`}>version {value.version} · 可见时每 3s 刷新</span>
    </div>
  )
}
