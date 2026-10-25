// Stage one：`git` 这个 tab 类型是什么。
// 页面型 tab 不声明 patterns，由 kind 打开；引导页卡片来自 guide。
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import { IconBranchOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'

/** 本插件拥有的 tab kind：openTab('git')。 */
export const GIT_KIND = 'git'

/** 实现身份，也是 body/title slot 注册用的 key。 */
export const GIT_ID = 'dsh-idea-gittool'

/**
 * Git 工作台的 tab 类型定义。
 * @param t - 绑定到 gitWorkbench 命名空间的翻译函数。
 */
export function gitDefinition(t: TranslateNS<'gitWorkbench'>): SidebarRightTabDefinition {
  return {
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'extension',
    title: () => t('type.label'),
    keepMounted: true,
    guide: [
      {
        id: 'log',
        commandId: 'git.openLog' as ShortcutCommandId,
        order: 40,
        title: () => t('guide.title'),
        description: () => t('guide.description'),
        icon: IconBranchOutlineMedium,
      },
    ],
  }
}
