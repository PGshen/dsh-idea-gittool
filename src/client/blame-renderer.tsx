/**
 * Optional "Git Blame" document renderer (design §9.7, plan B4a T5). Registered in the extension band
 * it outranks the built-in code viewer (references §16), so it exists only while the `blameRenderer`
 * setting is on; the preview's viewer list still offers "Code" per tab. The body reuses the B2 Blame
 * view; files outside a repository or not tracked yet show their text with the reason.
 */
import type { ReactNode } from 'react'
import { CODE_HIGHLIGHT_EXTENSIONS } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewDefinition, DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import css from './blame-renderer.module.css'
import type { BootstrapCache } from './bootstrap-cache.ts'
import { toRepoRelativePath } from './document-actions.tsx'
import type { GitClient } from './git-client.ts'
import { I18nProvider, useT } from './i18n.tsx'
import { BlameOverlay } from './pages/BlameView.tsx'
import { useBootstrap } from './use-bootstrap.ts'
import type { WorkbenchIntent } from './workbench-intents.ts'

/** Implementation id, also the keyed `sidebar.right.tab.document` slot key. */
export const BLAME_RENDERER_ID = 'dsh-idea-gittool/blame'

/**
 * Suffixes DSH shows with a dedicated `builtin` viewer (Markdown, HTML, spreadsheet, image, PDF;
 * `ui-sidebar-documentpreview/src/client/<viewer>/index.ts`). The code table also lists some of them, and the
 * extension band would take them over, so the renderer only claims the rest (review I1).
 */
export const RENDERED_BY_DSH: readonly string[] = [
  'md', 'markdown', 'html', 'htm', 'xlsx', 'xls', 'csv', 'tsv', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
]

export function blameRendererDefinition(title: () => string): DocumentPreviewDefinition {
  const extensions = CODE_HIGHLIGHT_EXTENSIONS.filter(extension => !RENDERED_BY_DSH.includes(extension))
  return { id: BLAME_RENDERER_ID, extensions, priority: 'extension', title, loading: 'text-pages' }
}

/** The registry surface used here (DSH `DocumentPreviewRegistry`). */
export interface PreviewRegistryLike {
  register(definition: DocumentPreviewDefinition): () => void
}

/** The setting as an observable boolean. */
export interface BooleanSource {
  read(): boolean
  subscribe(listener: (on: boolean) => void): () => void
}

/**
 * Keep the definition registered exactly while the setting is on.
 * @returns cleanup: stop listening and unregister.
 */
export function bindBlameRenderer(registry: PreviewRegistryLike, definition: DocumentPreviewDefinition, setting: BooleanSource): () => void {
  let dispose: (() => void) | null = null
  const sync = (on: boolean): void => {
    if (on && dispose === null) {
      try {
        dispose = registry.register(definition)
      } catch {
        // A duplicate id (another copy of the plugin) must not take the workbench down.
        dispose = null
      }
    } else if (!on && dispose !== null) {
      dispose()
      dispose = null
    }
  }
  sync(setting.read())
  const unsubscribe = setting.subscribe(sync)
  return () => {
    unsubscribe()
    sync(false)
  }
}

export type BlameRendererState =
  | { kind: 'loading' }
  | { kind: 'outside' }
  | { kind: 'untracked' }
  | { kind: 'blame'; path: string }

/** What the body shows for a file, given the session's repository snapshot. */
export function blameRendererState(input: {
  absolutePath: string | undefined
  repoRoot: string | null
  bootstrapLoaded: boolean
  untrackedPaths: readonly string[]
}): BlameRendererState {
  if (input.absolutePath === undefined || !input.bootstrapLoaded) return { kind: 'loading' }
  const path = toRepoRelativePath(input.absolutePath, input.repoRoot)
  if (path === null) return { kind: 'outside' }
  if (input.untrackedPaths.includes(path)) return { kind: 'untracked' }
  return { kind: 'blame', path }
}

/** The file text with the reason there is no blame. */
export function BlameRendererFallback(props: { reason: 'outside' | 'untracked'; text: string; wrap: boolean }): ReactNode {
  const t = useT()
  return (
    <div className={css.fallback}>
      <p className={css.notice} role="status">{t(props.reason === 'outside' ? 'blameRenderer.outsideRepo' : 'blameRenderer.untracked')}</p>
      <pre className={props.wrap ? `${css.text} ${css.wrap}` : css.text}>{props.text}</pre>
    </div>
  )
}

/** What the body needs besides the document owner props (injected at registration). */
export interface BlameRendererInjected {
  gitClient: GitClient
  bootstrapCache: BootstrapCache
  openInGit: (sessionId: string, intent: WorkbenchIntent) => void
}

export type BlameRendererProps = DocumentPreviewProps & PropsLocale<'gitWorkbench'> & BlameRendererInjected

export function BlameRendererBody(props: BlameRendererProps): ReactNode {
  return (
    <I18nProvider t={props.t}>
      <BlameRendererContent {...props} />
    </I18nProvider>
  )
}

function BlameRendererContent({ sessionId, resourceAddress, useResource, content, wrap, gitClient, bootstrapCache, openInGit }: BlameRendererProps): ReactNode {
  const absolutePath = useResource<'file'>(resourceAddress).value?.absolutePath
  const bootstrap = useBootstrap(bootstrapCache, sessionId)
  const state = blameRendererState({
    absolutePath,
    repoRoot: bootstrap?.repoRoot ?? null,
    bootstrapLoaded: bootstrap !== null,
    untrackedPaths: bootstrap?.status?.untracked.map(entry => entry.path) ?? [],
  })
  const text = content.kind === 'text' ? content.text : ''
  if (state.kind === 'loading') return null
  if (state.kind !== 'blame') return <BlameRendererFallback reason={state.kind} text={text} wrap={wrap} />
  // Reload the blame when the owner finished reading a changed file (the worktree text is blamed).
  const textVersion = content.kind === 'text' && content.eof ? String(content.text.length) : 'reading'
  return (
    <div className={css.host}>
      <BlameOverlay
        key={`${state.path}:${textVersion}`}
        sessionId={sessionId}
        target={{ path: state.path }}
        load={(request, signal) => gitClient.blame(request, signal)}
        loadDiff={(request, signal) => gitClient.diff(request, signal)}
        branch={bootstrap?.status?.branch ?? null}
        onShowInLog={(sha) => { openInGit(sessionId, { kind: 'showCommit', sha }) }}
        onFileHistory={(file) => { openInGit(sessionId, { kind: 'fileHistory', path: file }) }}
        // Ignored files (and untracked ones past the status limit) only show up here (review I2).
        renderUntracked={() => <BlameRendererFallback reason="untracked" text={text} wrap={wrap} />}
      />
    </div>
  )
}
