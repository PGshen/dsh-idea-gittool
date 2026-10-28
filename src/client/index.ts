// Client 半边入口：把 git tab 类型、引导页卡片、快捷键与正文/标题接进 DSH。
// 两段式注册（可行性调研 §1.1）：类型进 sidebarRightTabs，正文/标题进 keyed slot。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { BLAME_RENDERER_ID, BlameRendererBody, bindBlameRenderer, blameRendererDefinition } from './blame-renderer.tsx'
import { createBootstrapCache } from './bootstrap-cache.ts'
import { GIT_ID, GIT_KIND, gitDefinition } from './definition.tsx'
import { createGitClient } from './git-client.ts'
import { GitBody } from './GitBody.tsx'
import { GitTitle } from './GitTitle.tsx'
import { en, zh } from './locales.ts'
import { text } from './localized-text.ts'
import { registerBlameTab, registerDocumentActions } from './register-document-actions.ts'
import { readSettings, subscribeSettings } from './settings.ts'
import { useStatusLetter } from './use-bootstrap.ts'
import { postIntent } from './workbench-intents.ts'
import type { WorkbenchIntent } from './workbench-intents.ts'

export const name = 'dsh-idea-gittool'

const NS = 'gitWorkbench'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'shortcuts']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const gitClient = createGitClient(ctx)
  const bootstrapCache = createBootstrapCache(gitClient)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(gitDefinition(t)), 'git: tab type')

  ctx.effect(() => ctx.shortcuts.register({
    id: 'git.openLog' as ShortcutCommandId,
    label: () => t('shortcut.open'),
    aliases: ['git', 'git log', 'git workbench'],
    defaults: {
      'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
    },
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: ({ target: element }) => {
      const target = ctx.sidebarRight.commandTarget(element)
      if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
      return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget(GIT_KIND, target) } }
    },
  }), 'git: shortcut')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: GIT_ID,
      locale: NS,
      inject: () => ({
        bootstrapCache,
        gitClient,
        // B1 merge window: host fullscreen of the pane that holds the Git tab (references §14).
        toggleFullscreen: (element: Element | null) => {
          const target = ctx.sidebarRight.commandTarget(element)
          if (target !== undefined) ctx.sidebarRight.toggleFullscreen(target)
        },
      }),
    },
    GitBody,
  )), 'git: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: GIT_ID, locale: NS, inject: () => ({ bootstrapCache }) },
    GitTitle,
  )), 'git: tab title')

  // 文档预览头部动作 + git.blame 页（B2：Blame 视图）；状态字母复用同一份 bootstrap 快照。
  // 页里的「在日志中显示」「文件历史」经意图队列交给本会话的 Git tab，并把它切到前面。
  const openInGit = (sessionId: string, intent: WorkbenchIntent): boolean => {
    postIntent(sessionId, intent)
    try {
      ctx.sidebarRight.openTab(GIT_KIND)
      return true
    } catch {
      // No Session on screen: the intent waits until the Git tab of that session mounts.
      return false
    }
  }
  registerBlameTab(ctx, { gitClient, bootstrapCache, openInGit: (sessionId, intent) => { openInGit(sessionId, intent) } })

  // B4a: optional "Git Blame" document renderer. The keyed body is always registered (inert while no
  // definition selects it); the definition follows the setting, and only when DSH provides the
  // document preview registry (cordis runs an inject callback once the service exists).
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.document',
      key: BLAME_RENDERER_ID,
      locale: NS,
      inject: () => ({ gitClient, bootstrapCache, openInGit: (sessionId: string, intent: WorkbenchIntent) => { openInGit(sessionId, intent) } }),
    },
    BlameRendererBody,
  )), 'git: blame renderer body')
  ctx.inject(['documentPreviews'], (previews) => {
    previews.effect(() => bindBlameRenderer(
      previews.documentPreviews,
      blameRendererDefinition(() => t('blameRenderer.title')),
      { read: () => readSettings().blameRenderer, subscribe: listener => subscribeSettings((next) => { listener(next.blameRenderer) }) },
    ), 'git: blame renderer definition')
  })
  registerDocumentActions(ctx, {
    useStatus: (absolutePath, sessionId) => useStatusLetter(bootstrapCache, sessionId, absolutePath),
    repoRootFor: (_absolutePath, sessionId) => bootstrapCache.get(sessionId)?.repoRoot ?? null,
    openInGit: (sessionId, intent) => (openInGit(sessionId, intent) ? null : text('document.noSession.git')),
  })
}
