// `gitWorkbench` 文案命名空间与键集。
// zh 是键的真源，en 用 satisfies 保证键一致。
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git 工作台的页签、引导卡片与快捷键文案。 */
    gitWorkbench: GitWorkbenchKey
  }
}

/** 简体中文文案（M0 spike 先只覆盖入口）。 */
export const zh = {
  'type.label': 'Git',
  'guide.title': 'Git 工作台',
  'guide.description': '提交图、历史与工作区改动',
  'shortcut.open': 'Git: 打开工作台',
  'shortcut.noSession': '请先选择会话',
  'body.title': 'Git 工作台',
  'body.emptyNoCwd': '这个会话没有工作目录。',
  'body.spike': 'M0 集成 spike：RPC 数据接入中。',
} satisfies Record<string, string>

export type GitWorkbenchKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Git',
  'guide.title': 'Git workbench',
  'guide.description': 'Commit graph, history and workspace changes',
  'shortcut.open': 'Git: Open workbench',
  'shortcut.noSession': 'Select a session first',
  'body.title': 'Git workbench',
  'body.emptyNoCwd': 'This session has no working directory.',
  'body.spike': 'M0 integration spike: wiring up RPC data.',
} satisfies Record<GitWorkbenchKey, string>
