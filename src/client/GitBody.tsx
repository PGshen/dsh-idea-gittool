// Git tab 的正文：bootstrap 快照 + 轮询；仓库内渲染 A1 工作台（日志/详情/diff/分支/控制台）。
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapCache } from './bootstrap-cache.ts'
import type { GitClient } from './git-client.ts'
import css from './GitBody.module.css'
import { I18nProvider, useT } from './i18n.tsx'
import { GitWorkbench } from './pages/GitWorkbench.tsx'
import { createPoller } from './polling.ts'
import { ReadOnlyBanner } from './read-only-banner.tsx'
import { useBootstrap } from './use-bootstrap.ts'

export interface GitBodyInjected {
  bootstrapCache: BootstrapCache
  gitClient: GitClient
  /** Toggles host fullscreen of the panel containing `element` (B1 merge window). */
  toggleFullscreen?: (element: Element | null) => void
}

/**
 * Slot entry: the registration declares `locale: 'gitWorkbench'`, so the framework injects `t`
 * (a new function on every locale switch). It reaches every component through I18nProvider.
 */
export type GitBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'gitWorkbench'> & GitBodyInjected

export function GitBody(props: GitBodyProps): ReactNode {
  return (
    <I18nProvider t={props.t}>
      <GitBodyContent {...props} />
    </I18nProvider>
  )
}

function GitBodyContent(props: GitBodyProps): ReactNode {
  const t = useT()
  const { sessionId, useTabInfo, useSessions, bootstrapCache, gitClient, toggleFullscreen } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const { tab, sidebar } = useTabInfo()
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
          ? <span className={css.muted}>{t('state.loading')}</span>
          : <span className={css.error}>{t('error.detail', { code: failure.code, message: failure.message })}</span>}
        {cwd === undefined ? null : <span className={css.mono}>{cwd}</span>}
      </div>
    )
  }

  if (value.repoRoot === null) {
    return (
      <div className={css.panel}>
        <ReadOnlyBanner policy={value.writePolicy} />
        <span className={css.mono}>{cwd ?? ''}</span>
        <span className={css.muted}>{t('body.notRepository')}</span>
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
      // Public tab info (references §14): includes the auto fullscreen of narrow viewports.
      sidebar={toggleFullscreen === undefined ? undefined : { fullscreen: sidebar.fullscreen, toggle: toggleFullscreen }}
    />
  )
}
