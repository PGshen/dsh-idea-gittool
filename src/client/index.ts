// Client 半边入口：把 git tab 类型、引导页卡片、快捷键与正文/标题接进 DSH。
// 两段式注册（可行性调研 §1.1）：类型进 sidebarRightTabs，正文/标题进 keyed slot。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createBootstrapCache } from './bootstrap-cache.ts'
import { GIT_ID, GIT_KIND, gitDefinition } from './definition.tsx'
import { createGitClient } from './git-client.ts'
import { GitBody } from './GitBody.tsx'
import { GitTitle } from './GitTitle.tsx'
import { en, zh } from './locales.ts'
import { registerBlameTab, registerDocumentActions } from './register-document-actions.ts'
import { useStatusLetter } from './use-bootstrap.ts'

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
    { name: 'sidebar.right.pane.tab', key: GIT_ID, locale: NS, inject: () => ({ bootstrapCache, gitClient }) },
    GitBody,
  )), 'git: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: GIT_ID },
    GitTitle,
  )), 'git: tab title')

  // M0 T6：文档预览头部动作 + git.blame 空页；状态字母复用同一份 bootstrap 快照。
  registerBlameTab(ctx)
  registerDocumentActions(ctx, {
    useStatus: (absolutePath, sessionId) => useStatusLetter(bootstrapCache, sessionId, absolutePath),
  })
}
