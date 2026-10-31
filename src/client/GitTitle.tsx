// Git tab title: branch icon, fixed "Git", plus the uncommitted-changes dot (design §5.3).
// The dot is computed from the shared bootstrap snapshot; the slot registration injects
// `bootstrapCache`. Without it (older registration) only the title renders.
import type { ReactNode } from 'react'
import { IconBranchOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootstrapValue } from '../shared/protocol.ts'
import type { BootstrapCache } from './bootstrap-cache.ts'
import { useLocalizedT } from './i18n.tsx'
import css from './GitTitle.module.css'
import { OPERATION_KEY } from './locales.ts'
import type { Translate } from './localized-text.ts'
import { uncommittedCount } from './store/changes-store.ts'
import { useBootstrap } from './use-bootstrap.ts'

export interface TitleDot {
  /** `brand` for plain uncommitted changes; `warning` for conflicts or an operation in progress. */
  tone: 'brand' | 'warning'
  tooltip: string
}

/**
 * The tab-title dot for a bootstrap snapshot.
 * @param value - latest snapshot, or null before the first load.
 * @param t - translator for the tooltip.
 * @returns null when the work tree is clean (or there is no repository).
 */
export function titleDot(value: BootstrapValue | null, t: Translate): TitleDot | null {
  const status = value?.status ?? null
  if (status === null) return null
  const conflicts = status.conflicts.length
  if (status.operation !== null || conflicts > 0) {
    const parts: string[] = []
    if (status.operation !== null) parts.push(t('title.operation', { operation: t(OPERATION_KEY[status.operation]) }))
    if (conflicts > 0) parts.push(t('count.conflicts', { count: conflicts }))
    return { tone: 'warning', tooltip: parts.join(t('title.separator')) }
  }
  const count = uncommittedCount(status)
  if (count === 0) return null
  return { tone: 'brand', tooltip: t('title.uncommitted', { count }) }
}

/** Presentational title (no hooks): branch icon, text, then the optional dot. */
export function GitTitleView({ title, dot }: { title: ReactNode; dot: TitleDot | null }): ReactNode {
  return (
    <span className={css.title} title={dot?.tooltip}>
      <span className={css.icon} data-git-title-icon="">
        <IconBranchOutlineMedium size={14} />
      </span>
      {title}
      {dot !== null && (
        <span
          className={`${css.dot} ${dot.tone === 'warning' ? css.warning : css.brand}`}
          role="img"
          aria-label={dot.tooltip}
          data-git-title-dot={dot.tone}
        />
      )}
    </span>
  )
}

function TitleWithDot({ title, cache, sessionId, t }: { title: ReactNode; cache: BootstrapCache; sessionId: string; t: Translate }): ReactNode {
  const value = useBootstrap(cache, sessionId)
  return <GitTitleView title={title} dot={titleDot(value, t)} />
}

export interface GitTitleInjected {
  bootstrapCache?: BootstrapCache
}

export function GitTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'gitWorkbench'> & GitTitleInjected): ReactNode {
  const { useTabInfo, bootstrapCache, sessionId } = props
  const t = useLocalizedT(props.t)
  const { tab } = useTabInfo()
  if (bootstrapCache === undefined) return <GitTitleView title={tab.title} dot={null} />
  return <TitleWithDot title={tab.title} cache={bootstrapCache} sessionId={sessionId} t={t} />
}
