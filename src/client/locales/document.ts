// 文档预览头部动作与 git.blame 占位页。

export const zhDocument = {
  'document.status.pending': 'Git 状态待接入',
  'document.status': 'Git 状态：{status}',
  'document.history': '历史',
  'document.history.pending': '历史视图将在 B2 实现',
  'document.diff.pending': 'Diff 视图将在 B2 实现',
  'document.noSession': '没有可用的会话，无法打开 Blame 视图',
  'blame.title': 'Blame 视图将在 B2 实现',
  'blame.missing': '未提供文件路径，无法定位要标注的文件。',
  'blame.file': '文件：',
  'blame.repoPath': '仓库相对路径：',
  'blame.note': 'M0 只验证文档预览头部动作与 openTab 跳转；行级 blame 数据由 Host RPC 在 B2 提供。',
} satisfies Record<string, string>

export const enDocument = {
  'document.status.pending': 'Git status not wired yet',
  'document.status': 'Git status: {status}',
  'document.history': 'History',
  'document.history.pending': 'The history view arrives in B2',
  'document.diff.pending': 'The diff view arrives in B2',
  'document.noSession': 'No session is available, so the Blame view cannot open',
  'blame.title': 'The Blame view arrives in B2',
  'blame.missing': 'No file path was provided, so there is no file to annotate.',
  'blame.file': 'File: ',
  'blame.repoPath': 'Repository-relative path: ',
  'blame.note': 'M0 only verifies the document header action and the openTab jump; line-level blame data comes from the Host RPC in B2.',
} satisfies Record<keyof typeof zhDocument, string>
