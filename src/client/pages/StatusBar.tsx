// 状态栏（设计 §7.4）：24px 一行。左：分支/detached、↑↓、工作区摘要、贮藏数、操作进度；
// 右：Git 版本、最近刷新时间、自动刷新开关。
import type { ReactNode } from 'react'
import type { StatusValue } from '../../shared/protocol.ts'
import { formatAheadBehind, shortSha } from './branch-store.ts'
import { OPERATION_LABEL } from './OperationBanner.tsx'
import css from './StatusBar.module.css'

export interface StatusBarProps {
  status: StatusValue | null
  /** 贮藏数；协议暂未提供时传 undefined/null，显示占位。 */
  stashCount?: number | null
  onOpenStash?: () => void
  /** 最近一次成功刷新的时间戳（ms）。 */
  lastRefreshAt: number | null
  autoRefresh: boolean
  onToggleAutoRefresh: () => void
  gitVersion?: string | null
}

export type WorktreeTone = 'clean' | 'changes' | 'conflict'

/** 工作区摘要：冲突优先，其次去重后的修改数（staged/unstaged/untracked）。 */
export function summarizeWorktree(status: StatusValue): { tone: WorktreeTone; text: string } {
  if (status.conflicts.length > 0) return { tone: 'conflict', text: `${status.conflicts.length} 个冲突` }
  const paths = new Set<string>()
  for (const list of [status.staged, status.unstaged, status.untracked]) {
    for (const entry of list) paths.add(entry.path)
  }
  if (paths.size === 0 && !status.truncated) return { tone: 'clean', text: '无改动' }
  return { tone: 'changes', text: `${paths.size}${status.truncated ? '+' : ''} 个修改` }
}

/** 本地时区 HH:mm:ss。 */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function StatusBar(props: StatusBarProps): ReactNode {
  const { status, stashCount, lastRefreshAt, autoRefresh, gitVersion } = props
  const summary = status === null ? null : summarizeWorktree(status)
  const aheadBehind = status === null ? '' : formatAheadBehind(status.ahead, status.behind)
  const stashKnown = typeof stashCount === 'number'
  const stashText = stashKnown ? `${stashCount} 个贮藏` : '贮藏 —'

  return (
    <div role="status" aria-live="polite" className={css.bar} data-dsh-git-status-bar="">
      {status === null
        ? <span className={css.item}>—</span>
        : (
            <span
              className={`${css.item} ${status.detached ? css.danger : css.branch}`}
              data-detached={status.detached}
              title={status.upstream === null ? undefined : `上游：${status.upstream}`}
            >
              ⎇ {status.detached ? `detached ${shortSha(status.head ?? '')}` : (status.branch ?? '—')}
            </span>
          )}
      {aheadBehind === '' ? null : <span className={`${css.item} ${css.mono}`}>{aheadBehind}</span>}
      {summary === null
        ? null
        : <span className={`${css.item} ${css[summary.tone] ?? ''}`} data-tone={summary.tone}>{summary.text}</span>}
      {stashKnown && props.onOpenStash !== undefined
        ? (
            <button type="button" className={`${css.item} ${css.link}`} data-stash={String(stashCount)} onClick={props.onOpenStash}>
              {stashText}
            </button>
          )
        : (
            <span
              className={`${css.item} ${stashKnown ? '' : css.muted}`}
              data-stash={stashKnown ? String(stashCount) : 'unknown'}
              title={stashKnown ? undefined : '贮藏数暂不可用'}
            >
              {stashText}
            </span>
          )}
      {status?.operation == null
        ? null
        : <span className={`${css.item} ${css.warn}`}>{OPERATION_LABEL[status.operation]}中</span>}
      <span className={css.spacer} />
      {gitVersion == null ? null : <span className={`${css.item} ${css.muted}`}>Git {gitVersion}</span>}
      <span className={`${css.item} ${css.muted}`}>
        {lastRefreshAt === null ? '尚未刷新' : `${formatClock(lastRefreshAt)} 刷新`}
      </span>
      <button
        type="button"
        className={css.toggle}
        aria-pressed={autoRefresh}
        aria-label="自动刷新"
        title={autoRefresh ? '自动刷新已开启（每 3 秒）' : '自动刷新已关闭'}
        onClick={props.onToggleAutoRefresh}
      >
        ⟳
      </button>
    </div>
  )
}
