// Git tab 的正文：bootstrap 快照 + 轮询；仓库内渲染 A1 工作台（日志/详情/diff/分支/控制台）。
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapCache } from './bootstrap-cache.ts'
import type { GitClient } from './git-client.ts'
import css from './GitBody.module.css'
import { GitWorkbench } from './pages/GitWorkbench.tsx'
import { createPoller } from './polling.ts'
import { ReadOnlyBanner } from './read-only-banner.tsx'
import { useBootstrap } from './use-bootstrap.ts'

export interface GitBodyInjected {
  bootstrapCache: BootstrapCache
  gitClient: GitClient
}

export function GitBody(props: PropsRuntime<'sidebar.right.pane.tab'> & GitBodyInjected): ReactNode {
  const { sessionId, useTabInfo, useSessions, bootstrapCache, gitClient } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const { tab } = useTabInfo()
  const visible = tab.visible
  const value = useBootstrap(bootstrapCache, sessionId)
  const failure = bootstrapCache.getFailure(sessionId)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)

  useEffect(() => {
    if (value !== null) setLastRefreshAt(Date.now())
  }, [value])

  useEffect(() => {
    const poller = createPoller({
      isVisible: () => visible && autoRefresh,
      refresh: () => bootstrapCache.refresh(sessionId).then(version => ({ version })),
    })
    poller.start()
    return () => poller.stop()
  }, [autoRefresh, bootstrapCache, sessionId, visible])

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

  if (value.repoRoot === null) {
    return (
      <div className={css.panel}>
        <ReadOnlyBanner policy={value.writePolicy} />
        <span className={css.mono}>{cwd ?? ''}</span>
        <span className={css.muted}>当前会话目录不在 Git 仓库中。在仓库里打开会话后，这里会显示提交与工作区状态。</span>
      </div>
    )
  }

  return (
    <GitWorkbench
      sessionId={sessionId}
      client={gitClient}
      value={value}
      onRefresh={() => bootstrapCache.refresh(sessionId)}
      autoRefresh={autoRefresh}
      onToggleAutoRefresh={() => { setAutoRefresh(enabled => !enabled) }}
      lastRefreshAt={lastRefreshAt}
    />
  )
}
