// B3a 交互式变基：变基列表页、日志快捷动作、停下横幅。

export const zhRebase = {
  'rebase.invalid.not-permutation': '列表与仓库当前的提交不一致，请重新打开',
  'rebase.invalid.leading-squash': '第一条保留的提交不能是 squash 或 fixup：没有可以合入的上一条提交',
  'rebase.invalid.missing-message': '提交信息不能为空',
  'rebase.invalid.misplaced-message': '只有 pick 和 reword 的提交可以改提交信息',
  'rebase.invalid.unchanged': '没有任何改动',
  'rebase.invalid.confirmPushed': '请先勾选「我了解这会改写已推送的历史」',
}

export const enRebase = {
  'rebase.invalid.not-permutation': 'The list no longer matches the repository; reopen it',
  'rebase.invalid.leading-squash': 'The first kept commit cannot be squash or fixup: there is no earlier commit to fold into',
  'rebase.invalid.missing-message': 'The commit message must not be empty',
  'rebase.invalid.misplaced-message': 'Only pick and reword commits can change their message',
  'rebase.invalid.unchanged': 'Nothing has changed',
  'rebase.invalid.confirmPushed': 'Confirm "I understand this rewrites pushed history" first',
} satisfies Record<keyof typeof zhRebase, string>
