// B3b Diff 增强与提交菜单：Diff 工具栏、折叠、提交菜单新项、标签/撤销/Fixup 浮层、补丁页。

export const zhDiffMenu = {
  'diff.fold.expand': '展开 {count} 行未改内容',
  'diff.mode.unified': '统一',
  'diff.mode.split': '并排',
  'diff.mode.title': '统一 / 并排显示',
  'diff.mode.narrow': '需要更宽的面板（可用右上角全屏）',
  'diff.ignoreWhitespace': '忽略空白',
  'diff.ignoreWhitespace.title': '忽略空白差异后重新比较（git diff -w）',
  'diff.fullFile': '完整文件',
  'diff.fullFile.title': '显示整个文件，长段未改内容折叠',
  'diff.noTextChange.whitespace': '没有文本差异（已忽略空白）',
  'diff.keys': 'n / p 下一个 / 上一个变更',
}

export const enDiffMenu = {
  'diff.fold.expand': 'Show {count} unchanged lines',
  'diff.mode.unified': 'Unified',
  'diff.mode.split': 'Side by side',
  'diff.mode.title': 'Unified / side-by-side view',
  'diff.mode.narrow': 'Needs a wider panel (use fullscreen at the top right)',
  'diff.ignoreWhitespace': 'Ignore whitespace',
  'diff.ignoreWhitespace.title': 'Compare again ignoring whitespace (git diff -w)',
  'diff.fullFile': 'Whole file',
  'diff.fullFile.title': 'Show the whole file with long unchanged runs folded',
  'diff.noTextChange.whitespace': 'No text differences (whitespace ignored)',
  'diff.keys': 'n / p next / previous change',
} satisfies Record<keyof typeof zhDiffMenu, string>
