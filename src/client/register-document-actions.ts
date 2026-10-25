/**
 * Registrations for M0 T6: the document-preview header actions and the
 * `git.blame` page. Kept out of `src/client/index.ts` so the entry only wires
 * what it needs and this module can be unit-tested with a fake context.
 *
 * Everything here registers through the public Sidebar paths: the type into
 * `ctx.sidebarRightTabs`, its body into `sidebar.right.pane.tab`, and the
 * header contribution into `sidebar.right.tab.document.actions`. Each
 * registration is wrapped in `ctx.effect` so plugin unload reclaims it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Declares the `slots` service on Context and the document-actions seat.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { BlamePage } from './blame-page.tsx'
import { DocumentActions } from './document-actions.tsx'
import { statusLetterOf } from './document-actions.tsx'
import type { DocumentActionsInjected } from './document-actions.tsx'

/** Tab kind of the blame page; this plugin's public page identity. */
export const BLAME_KIND = 'git.blame'

/** Implementation identity of the blame page in the Sidebar tab registry. */
export const BLAME_TAB_ID = 'dsh-idea-gittool.git-blame'

/** List-entry identity of the document-header contribution. */
export const DOCUMENT_ACTIONS_ID = 'dsh-idea-gittool.document-actions'

const DOCUMENT_ACTIONS_SLOT = 'sidebar.right.tab.document.actions'

/** Optional lookups the entry can wire once the Host status source lands. */
export interface RegisterDocumentActionsOptions {
  /**
   * Raw git status code (porcelain `XY` or a single letter) for one file; the
   * header reduces it to the display letter with `statusLetterOf`.
   * @param absolutePath - file the header acted on.
   * @param sessionId - session whose Sidebar hosts the document.
   */
  readonly statusCodeFor?: (absolutePath: string, sessionId: string) => string | null
  /**
   * Repository root for one file, used to derive the repo-relative path.
   * @param absolutePath - file the header acted on.
   * @param sessionId - session whose Sidebar hosts the document.
   */
  readonly repoRootFor?: (absolutePath: string, sessionId: string) => string | null
}

function blameDefinition(): SidebarRightTabDefinition {
  return {
    id: BLAME_TAB_ID,
    kind: BLAME_KIND,
    priority: 'extension',
    title: () => 'Blame',
    keepMounted: true,
  }
}

/**
 * Register the `git.blame` page: its type face and its body.
 * @param ctx - client context carrying the tab registry and the slot registry.
 */
export function registerBlameTab(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.sidebarRightTabs.register(blameDefinition()),
    'git: blame tab type',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: BLAME_TAB_ID,
    }, BlamePage)),
    'git: blame body',
  )
}

/**
 * Register the document-header contribution that shows the git status letter
 * and opens the blame page.
 * @param ctx - client context carrying the slot registry and the Sidebar face.
 * @param options - optional status and repository-root lookups.
 */
export function registerDocumentActions(
  ctx: ClientContext,
  options: RegisterDocumentActionsOptions = {},
): void {
  ctx.effect(
    () => ctx.slots.inject(DOCUMENT_ACTIONS_SLOT, () => ctx.slots.register({
      name: DOCUMENT_ACTIONS_SLOT,
      id: DOCUMENT_ACTIONS_ID,
      inject: (sessionId): DocumentActionsInjected => ({
        openBlame: (absolutePath, repoRelativePath) => {
          try {
            ctx.sidebarRight.openTab(BLAME_KIND, { params: { absolutePath, repoRelativePath } })
            return null
          } catch {
            // `openTab` throws while no Session is on screen; surface it in the header.
            return '没有可用的会话，无法打开 Blame 视图'
          }
        },
        statusFor: absolutePath => statusLetterOf(options.statusCodeFor?.(absolutePath, sessionId)),
        repoRootFor: absolutePath => options.repoRootFor?.(absolutePath, sessionId) ?? null,
      }),
    }, DocumentActions)),
    'git: document actions',
  )
}

/**
 * Whether the running DSH composition declares the document-header seat.
 * Hosts without it fall back to another entry (the Git tab) for Blame.
 * @param ctx - client context carrying the slot registry.
 * @returns true when `sidebar.right.tab.document.actions` is declared.
 */
export function hasDocumentActionsSlot(ctx: ClientContext): boolean {
  return ctx.slots.spec(DOCUMENT_ACTIONS_SLOT) !== undefined
}

/**
 * Open the blame page directly, for hosts that cannot host the header action.
 * @param ctx - client context carrying the Sidebar face.
 * @param absolutePath - file to annotate, when known.
 * @param repoRelativePath - repo-relative POSIX path, when the opener derived it.
 * @returns true when the page was opened; false while no Session is on screen.
 */
export function openBlameTab(
  ctx: ClientContext,
  absolutePath?: string,
  repoRelativePath?: string,
): boolean {
  try {
    ctx.sidebarRight.openTab(
      BLAME_KIND,
      absolutePath === undefined ? {} : { params: { absolutePath, repoRelativePath } },
    )
    return true
  } catch {
    return false
  }
}
