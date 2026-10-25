// Git tab 的页签标题。M0 先直接显示类型标题，避免 "Git · Git" 重复。
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export function GitTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <>{tab.title}</>
}
