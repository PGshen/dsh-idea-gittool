// B1 三栏合并窗口：store 产生的提示文案（窗口自身的文案由 T6 追加到本分区）。

export const zhMerge = {
  'merge.error.stale': '文件已变化，请重新加载',
  'merge.error.loadFailed': '读取合并内容失败：{code}',
  'merge.draftDiscarded': '这个文件的三方版本已变化，之前保存的草稿已作废，已从头开始。',
} as const

export const enMerge = {
  'merge.error.stale': 'The file has changed; reload it',
  'merge.error.loadFailed': 'Failed to read the merge content: {code}',
  'merge.draftDiscarded': 'The three versions of this file have changed, so the saved draft was discarded and you are starting over.',
} satisfies Record<keyof typeof zhMerge, string>
