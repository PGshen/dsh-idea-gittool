// 各页面共用的动作与提示。

export const zhCommon = {
  'action.retry': '重试',
  'action.retryHint': '请重试',
  'action.close': '关闭',
  'action.cancel': '取消',
  'action.refresh': '刷新',
} satisfies Record<string, string>

export const enCommon = {
  'action.retry': 'Retry',
  'action.retryHint': 'Please try again',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.refresh': 'Refresh',
} satisfies Record<keyof typeof zhCommon, string>
