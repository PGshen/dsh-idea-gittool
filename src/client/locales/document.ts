// 文档预览头部动作（git.blame 页的文案在 history.ts）。

export const zhDocument = {
  'document.status.pending': 'Git 状态待接入',
  'document.status': 'Git 状态：{status}',
  'document.history': '历史',
  'document.diff.clean': '文件没有未提交的改动',
  'document.notInRepo': '文件不在当前会话的 Git 仓库中',
  'document.more': '更多 Git 动作',
  'document.status.open': '{status}：在提交页中查看这个改动',
  'document.history.title': '在 Git 工作台中打开这个文件的历史',
  'document.diff.title': '在 Git 工作台中打开这个文件的工作区 diff',
  'document.noSession': '没有可用的会话，无法打开 Blame 视图',
  'document.noSession.git': '没有可用的会话，无法打开 Git 工作台',
} satisfies Record<string, string>

export const enDocument = {
  'document.status.pending': 'Git status not wired yet',
  'document.status': 'Git status: {status}',
  'document.history': 'History',
  'document.diff.clean': 'The file has no uncommitted changes',
  'document.notInRepo': 'The file is not in the Git repository of this session',
  'document.more': 'More Git actions',
  'document.status.open': '{status}: show this change on the Commit page',
  'document.history.title': 'Open the history of this file in the Git workbench',
  'document.diff.title': 'Open the worktree diff of this file in the Git workbench',
  'document.noSession': 'No session is available, so the Blame view cannot open',
  'document.noSession.git': 'No session is available, so the Git workbench cannot open',
} satisfies Record<keyof typeof zhDocument, string>
