// Level 0 page switcher (design §5.2/§5.3): Log / Commit / Branches / Stash, with the
// uncommitted-files badge on Commit and the stash count badge on Stash.
import type { KeyboardEvent, ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import css from './PageTabs.module.css'

export type WorkbenchPage = 'log' | 'commit' | 'branches' | 'stash'

export const WORKBENCH_PAGES: readonly WorkbenchPage[] = ['log', 'commit', 'branches', 'stash']

const LABEL: Record<WorkbenchPage, GitWorkbenchKey> = {
  log: 'tabs.log',
  commit: 'tabs.commit',
  branches: 'tabs.branches',
  stash: 'tabs.stash',
}

/** Badge text: hidden at 0, capped at `99+`. */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

/** Arrow-key navigation between tabs (wraps around). */
export function adjacentPage(current: WorkbenchPage, key: string): WorkbenchPage | null {
  const index = WORKBENCH_PAGES.indexOf(current)
  const size = WORKBENCH_PAGES.length
  if (key === 'ArrowRight') return WORKBENCH_PAGES[(index + 1) % size] ?? null
  if (key === 'ArrowLeft') return WORKBENCH_PAGES[(index - 1 + size) % size] ?? null
  if (key === 'Home') return WORKBENCH_PAGES[0] ?? null
  if (key === 'End') return WORKBENCH_PAGES[size - 1] ?? null
  return null
}

export interface PageTabsProps {
  page: WorkbenchPage
  onChange: (page: WorkbenchPage) => void
  /** Uncommitted files (`uncommittedCount(status)`), shown on the Commit tab. */
  uncommittedCount: number
  /** Stashes (`status.stashCount`), shown on the Stash tab; hidden at 0 or when unknown. */
  stashCount?: number
  /** A sub-page (overlay) is open: switching pages would strand it, so every tab is disabled. */
  locked?: boolean
}

export function PageTabs({ page, onChange, uncommittedCount, stashCount = 0, locked = false }: PageTabsProps): ReactNode {
  const t = useT()
  const badge = badgeText(uncommittedCount)
  const stashBadge = badgeText(stashCount)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (locked) return
    const next = adjacentPage(page, event.key)
    if (next === null) return
    event.preventDefault()
    onChange(next)
    const target = event.currentTarget.querySelector<HTMLElement>(`[data-page="${next}"]`)
    target?.focus()
  }
  return (
    <div role="tablist" aria-label={t('tabs.tabsLabel')} className={css.tabs} data-locked={locked} onKeyDown={onKeyDown}>
      {WORKBENCH_PAGES.map((candidate) => {
        const selected = candidate === page
        return (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={`dsh-git-tab-${candidate}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={locked}
            className={selected ? `${css.tab} ${css.selected}` : css.tab}
            data-page={candidate}
            onClick={() => { if (!selected && !locked) onChange(candidate) }}
          >
            {t(LABEL[candidate])}
            {candidate === 'commit' && badge !== null
              ? (
                  <span className={css.badge} title={t('title.uncommitted', { count: uncommittedCount })} data-badge={uncommittedCount}>
                    {badge}
                  </span>
                )
              : null}
            {candidate === 'stash' && stashBadge !== null
              ? (
                  <span className={css.badge} title={t('status.stash', { count: stashCount })} data-stash-badge={stashCount}>
                    {stashBadge}
                  </span>
                )
              : null}
          </button>
        )
      })}
    </div>
  )
}
