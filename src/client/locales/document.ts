// 文档预览头部动作（git.blame 页的文案在 history.ts）。

export const zhDocument = {
  'document.status.pending': 'Git 状态待接入',
  'document.status': 'Git 状态：{status}',
  'document.history': '历史',
  'document.history.pending': '历史视图将在 B2 实现',
  'document.diff.pending': 'Diff 视图将在 B2 实现',
  'document.noSession': '没有可用的会话，无法打开 Blame 视图',
} satisfies Record<string, string>

export const enDocument = {
  'document.status.pending': 'Git status not wired yet',
  'document.status': 'Git status: {status}',
  'document.history': 'History',
  'document.history.pending': 'The history view arrives in B2',
  'document.diff.pending': 'The diff view arrives in B2',
  'document.noSession': 'No session is available, so the Blame view cannot open',
} satisfies Record<keyof typeof zhDocument, string>
