// 入口：tab 类型、引导卡片、快捷键与正文外壳。

export const zhCore = {
  'type.label': 'Git',
  'guide.title': 'Git 工作台',
  'guide.description': '提交图、历史与工作区改动',
  'shortcut.open': 'Git: 打开工作台',
  'shortcut.noSession': '请先选择会话',
  'body.notRepository': '当前会话目录不在 Git 仓库中。在仓库里打开会话后，这里会显示提交与工作区状态。',
} satisfies Record<string, string>

export const enCore = {
  'type.label': 'Git',
  'guide.title': 'Git workbench',
  'guide.description': 'Commit graph, history and workspace changes',
  'shortcut.open': 'Git: Open workbench',
  'shortcut.noSession': 'Select a session first',
  'body.notRepository': 'The session directory is not inside a Git repository. Open the session in a repository to see commits and workspace status here.',
} satisfies Record<keyof typeof zhCore, string>
