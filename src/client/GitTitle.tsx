// Git tab title: fixed "Git" plus the uncommitted-changes dot (design §5.3).
// The dot is computed from the shared bootstrap snapshot; the slot registration injects
// `bootstrapCache`. Without it (older registration) only the title renders.
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapValue, RepoOperation } from '../shared/protocol.ts'
import type { BootstrapCache } from './bootstrap-cache.ts'
import css from './GitTitle.module.css'
import { fillText, uncommittedCount } from './store/changes-store.ts'
import { useBootstrap } from './use-bootstrap.ts'

/** Visible strings of this module; moved into the locale namespace in T7. */
export const TEXT = {
  uncommitted: '{count} 个未提交文件',
  conflicts: '{count} 个冲突',
  operationMerge: '合并进行中',
  operationRebase: '变基进行中',
  operationCherryPick: '拣选进行中',
  operationRevert: '回滚提交进行中',
  operationBisect: '二分查找进行中',
  separator: ' · ',
} as const

const OPERATION_TEXT: Record<Exclude<RepoOperation, null>, string> = {
  merge: TEXT.operationMerge,
  rebase: TEXT.operationRebase,
  'cherry-pick': TEXT.operationCherryPick,
  revert: TEXT.operationRevert,
  bisect: TEXT.operationBisect,
}

export interface TitleDot {
  /** `brand` for plain uncommitted changes; `warning` for conflicts or an operation in progress. */
  tone: 'brand' | 'warning'
  tooltip: string
}

/**
 * The tab-title dot for a bootstrap snapshot.
 * @param value - latest snapshot, or null before the first load.
 * @returns null when the work tree is clean (or there is no repository).
 */
export function titleDot(value: BootstrapValue | null): TitleDot | null {
  const status = value?.status ?? null
  if (status === null) return null
  const conflicts = status.conflicts.length
  if (status.operation !== null || conflicts > 0) {
    const parts: string[] = []
    if (status.operation !== null) parts.push(OPERATION_TEXT[status.operation])
    if (conflicts > 0) parts.push(fillText(TEXT.conflicts, { count: conflicts }))
    return { tone: 'warning', tooltip: parts.join(TEXT.separator) }
  }
  const count = uncommittedCount(status)
  if (count === 0) return null
  return { tone: 'brand', tooltip: fillText(TEXT.uncommitted, { count }) }
}

/** Presentational title (no hooks): text followed by the optional dot. */
export function GitTitleView({ title, dot }: { title: ReactNode; dot: TitleDot | null }): ReactNode {
  if (dot === null) return <>{title}</>
  return (
    <span className={css.title} title={dot.tooltip}>
      {title}
      <span
        className={`${css.dot} ${dot.tone === 'warning' ? css.warning : css.brand}`}
        role="img"
        aria-label={dot.tooltip}
        data-git-title-dot={dot.tone}
      />
    </span>
  )
}

function TitleWithDot({ title, cache, sessionId }: { title: ReactNode; cache: BootstrapCache; sessionId: string }): ReactNode {
  const value = useBootstrap(cache, sessionId)
  return <GitTitleView title={title} dot={titleDot(value)} />
}

export interface GitTitleInjected {
  bootstrapCache?: BootstrapCache
}

export function GitTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & GitTitleInjected): ReactNode {
  const { useTabInfo, bootstrapCache, sessionId } = props
  const { tab } = useTabInfo()
  if (bootstrapCache === undefined) return <>{tab.title}</>
  return <TitleWithDot title={tab.title} cache={bootstrapCache} sessionId={sessionId} />
}
