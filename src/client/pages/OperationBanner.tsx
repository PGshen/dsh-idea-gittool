// 操作状态横幅（设计 §7.3）：仓库处于 merge/rebase/cherry-pick/revert/bisect 中时提示类型、目标分支与冲突数。
// A1 只读：只提供「查看控制台」；继续/中止/解决冲突留到 A3。
import type { ReactNode } from 'react'
import type { RepoOperation, StatusValue } from '../../shared/protocol.ts'
import { Button } from '../ui/Button.tsx'
import css from './OperationBanner.module.css'

/** 横幅展示的进行中操作（协议 RepoOperation 去掉 null；bisect 已由 Host 返回）。 */
export type BannerOperation = Exclude<RepoOperation, null>

export const OPERATION_LABEL: Record<BannerOperation, string> = {
  merge: '合并',
  rebase: '变基',
  'cherry-pick': '拣选',
  revert: '回滚',
  bisect: '二分',
}

export interface OperationBannerProps {
  operation: BannerOperation | null
  conflicts: number
  /** 当前（目标）分支；detached 时为 null。 */
  branch?: string | null
  onOpenConsole?: () => void
}

/** 从 StatusValue 推导横幅 props。 */
export function bannerFromStatus(status: StatusValue | null): Pick<OperationBannerProps, 'operation' | 'conflicts'> & { branch: string | null } {
  if (status === null) return { operation: null, conflicts: 0, branch: null }
  return { operation: status.operation, conflicts: status.conflicts.length, branch: status.branch }
}

export function OperationBanner({ operation, conflicts, branch = null, onOpenConsole }: OperationBannerProps): ReactNode {
  if (operation === null) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${css.banner} ${conflicts > 0 ? css.hasConflicts : ''}`}
      data-operation={operation}
      data-conflicts={conflicts}
    >
      <span className={css.icon} aria-hidden="true">⚠</span>
      <strong className={css.title}>正在{OPERATION_LABEL[operation]}</strong>
      {branch === null ? null : <span className={css.detail}>→ {branch}</span>}
      {conflicts > 0 ? <span className={css.conflicts}>· {conflicts} 个冲突</span> : null}
      <span className={css.hint}>请在终端完成或放弃该操作</span>
      <span className={css.spacer} />
      {onOpenConsole === undefined ? null : <Button onClick={onOpenConsole}>查看控制台</Button>}
    </div>
  )
}
