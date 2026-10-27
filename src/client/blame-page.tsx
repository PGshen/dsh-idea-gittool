/**
 * `git.blame` page body (plan B2 T5): the Blame view for the file the document header acted on.
 * The page follows its tab navigation: reopening it for another file steps `navigation.revision`
 * and the view reloads (references §15). Commit-level jumps ("show in log", file history) go to the
 * Git tab through the per-session intent queue.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the SlotMap declarations for 'sidebar.right.pane.tab'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './blame-page.module.css'
import type { BootstrapCache } from './bootstrap-cache.ts'
import { toRepoRelativePath } from './document-actions.tsx'
import type { GitClient } from './git-client.ts'
import { I18nProvider, useT } from './i18n.tsx'
import { BlameOverlay } from './pages/BlameView.tsx'
import { useBootstrap } from './use-bootstrap.ts'
import type { WorkbenchIntent } from './workbench-intents.ts'

/** The file a blame page was opened for. */
export interface BlameTarget {
  /** Absolute path in the file's execution environment. */
  readonly absolutePath: string
  /** Repo-relative POSIX path, when the opener could derive it. */
  readonly repoRelativePath?: string
}

/** What the page needs besides the framework props (injected at registration). */
export interface BlamePageInjected {
  gitClient: GitClient
  bootstrapCache: BootstrapCache
  /** Hand an intent to this session's Git tab and bring the tab forward. */
  openInGit: (sessionId: string, intent: WorkbenchIntent) => void
}

/** Props of the tab body: the framework's bound tab reader, the `gitWorkbench` translator and the injected face. */
export type BlamePageProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'gitWorkbench'> & BlamePageInjected

/**
 * Narrow the opaque navigation parameters to a blame target.
 * @param params - `tab.navigation.params`, typed only as a union by the Sidebar.
 * @returns the target, or null when the opener gave no usable absolute path.
 */
export function readBlameTarget(params: unknown): BlameTarget | null {
  if (typeof params !== 'object' || params === null) return null
  const candidate = params as { absolutePath?: unknown; repoRelativePath?: unknown }
  if (typeof candidate.absolutePath !== 'string' || candidate.absolutePath.length === 0) return null
  if (typeof candidate.repoRelativePath === 'string' && candidate.repoRelativePath.length > 0) {
    return { absolutePath: candidate.absolutePath, repoRelativePath: candidate.repoRelativePath }
  }
  return { absolutePath: candidate.absolutePath }
}

/** Repository path of the target: the opener's, else derived from the repository root; null outside it. */
export function blameRepoPath(target: BlameTarget, repoRoot: string | null): string | null {
  return target.repoRelativePath ?? toRepoRelativePath(target.absolutePath, repoRoot)
}

/** Identity of one navigation: a new open of the page (another file, or the same file again) changes it. */
export function blameNavigationKey(navigation: { revision: number; params?: unknown }): string {
  return `${String(navigation.revision)}:${JSON.stringify(navigation.params ?? null)}`
}

/** Why the page shows no blame. */
export function BlamePageNotice(props: { readonly reason: 'missing' | 'outside' | 'loading'; readonly absolutePath?: string }): ReactNode {
  const t = useT()
  const message = props.reason === 'missing'
    ? t('blame.page.missing')
    : props.reason === 'loading'
      ? t('blame.page.loading')
      : t('blame.page.outside', { path: props.absolutePath ?? '' })
  return (
    <div className={`git-blame-page ${css.page}`}>
      <p className={css.body} role="status">{message}</p>
    </div>
  )
}

/**
 * The registered tab body.
 * @param props - framework props carrying the bound `useTabInfo` reader, plus the injected face.
 * @returns the Blame view, or a notice.
 */
export function BlamePage(props: BlamePageProps): ReactNode {
  return (
    <I18nProvider t={props.t}>
      <BlamePageContent {...props} />
    </I18nProvider>
  )
}

function BlamePageContent({ sessionId, useTabInfo, gitClient, bootstrapCache, openInGit }: BlamePageProps): ReactNode {
  const { tab } = useTabInfo()
  const bootstrap = useBootstrap(bootstrapCache, sessionId)
  const target = readBlameTarget(tab.navigation.params)
  if (target === null) return <BlamePageNotice reason="missing" />
  if (bootstrap === null && target.repoRelativePath === undefined) return <BlamePageNotice reason="loading" />
  const path = blameRepoPath(target, bootstrap?.repoRoot ?? null)
  if (path === null) return <BlamePageNotice reason="outside" absolutePath={target.absolutePath} />
  return (
    <div className={css.host}>
      <BlameOverlay
        key={blameNavigationKey(tab.navigation)}
        sessionId={sessionId}
        target={{ path }}
        load={(request, signal) => gitClient.blame(request, signal)}
        loadDiff={(request, signal) => gitClient.diff(request, signal)}
        branch={bootstrap?.status?.branch ?? null}
        onShowInLog={(sha) => { openInGit(sessionId, { kind: 'showCommit', sha }) }}
        onFileHistory={(file) => { openInGit(sessionId, { kind: 'fileHistory', path: file }) }}
      />
    </div>
  )
}
