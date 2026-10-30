// Git tab 的正文：bootstrap 快照 + 轮询；仓库内渲染 A1 工作台（日志/详情/diff/分支/控制台）。
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapCache } from './bootstrap-cache.ts'
import type { GitClient } from './git-client.ts'
import css from './GitBody.module.css'
import { GitMissingView } from './git-missing.tsx'
import { applyGitPath, gitMissingOf, gitPathErrorText, isReadOnlySessionDenial } from './git-path.ts'
import { I18nProvider, useT } from './i18n.tsx'
import { GitWorkbench } from './pages/GitWorkbench.tsx'
import { createPoller } from './polling.ts'
import { ReadOnlyBanner } from './read-only-banner.tsx'
import { readSettings, refreshIntervalMs, useSettings, writeSettings } from './settings.ts'
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
  // B4a: auto refresh and its interval are settings (persisted; the status bar toggle writes them).
  const { autoRefresh, refreshIntervalSec, gitPath } = useSettings()
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [gitPathBusy, setGitPathBusy] = useState(false)
  const [gitPathError, setGitPathError] = useState<string | null>(null)
  // t2 T5: learned from the Host refusing a path; while git is missing there is no write policy.
  const [gitPathReadOnly, setGitPathReadOnly] = useState(false)
  const mounted = useRef(true)
  const gitPathCall = useRef(0)
  useEffect(() => () => { mounted.current = false }, [])

  /** B4d: hand `path` (or the stored setting when undefined) to the Host, then re-read bootstrap. */
  const sendGitPath = async (path?: string): Promise<void> => {
    // Review M4: only the latest call may report; an earlier, superseded one must not overwrite it.
    const call = ++gitPathCall.current
    setGitPathBusy(true)
    let error: string | null = null
    let readOnly = false
    if (path === undefined) {
      const stored = readSettings().gitPath
      const result = await gitClient.gitExecutable({ sessionId, path: stored })
      // t2 T5: a session that may not change the git path keeps whatever git the Host already
      // runs; re-sending the stored path there is routine, not an error to show.
      if (!result.ok) {
        readOnly = isReadOnlySessionDenial(result.error)
        if (result.error.code !== 'git/sandbox-denied') error = gitPathErrorText(result.error, t)
      }
    } else {
      const outcome = await applyGitPath(gitClient, sessionId, path, t)
      if (!outcome.ok) {
        error = outcome.message
        readOnly = outcome.readOnly === true
      }
    }
    // A fresh bootstrap: one already in flight was read with the previous git (final review M2).
    await bootstrapCache.reload(sessionId)
    if (!mounted.current || call !== gitPathCall.current) return
    if (readOnly) setGitPathReadOnly(true)
    setGitPathError(error)
    setGitPathBusy(false)
  }

  // The Host keeps a set git path in memory only (decision 1): hand it over again on every mount.
  useEffect(() => {
    if (readSettings().gitPath !== null) void sendGitPath()
    // Mount only: later changes go through the settings sheet or the empty state.
  }, [])

  useEffect(() => {
    if (value !== null) setLastRefreshAt(Date.now())
  }, [value])

  useEffect(() => {
    const poller = createPoller({
      intervalMs: refreshIntervalMs({ refreshIntervalSec }),
      isVisible: () => visible && autoRefresh,
      refresh: () => bootstrapCache.refresh(sessionId).then(version => ({ version })),
    })
    poller.start()
    return () => poller.stop()
  }, [autoRefresh, bootstrapCache, refreshIntervalSec, sessionId, visible])

  const missing = gitMissingOf(failure)
  if (value === null && missing !== null) {
    return (
      <GitMissingView
        missing={missing}
        gitPath={gitPath}
        busy={gitPathBusy}
        error={gitPathError}
        readOnly={gitPathReadOnly}
        onRedetect={() => { void sendGitPath() }}
        onApply={(path) => { void sendGitPath(path) }}
      />
    )
  }

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
      onReload={() => bootstrapCache.reload(sessionId)}
      autoRefresh={autoRefresh}
      onToggleAutoRefresh={() => { writeSettings({ autoRefresh: !autoRefresh }) }}
      lastRefreshAt={lastRefreshAt}
      // Public tab info (references §14): includes the auto fullscreen of narrow viewports.
      sidebar={toggleFullscreen === undefined ? undefined : { fullscreen: sidebar.fullscreen, toggle: toggleFullscreen }}
    />
  )
}
