// Level 0 page switcher (design §5.2/§5.3): Log / Commit, with the uncommitted-files badge.
// Branch and stash pages arrive in A3; no empty tabs before then.
import type { KeyboardEvent, ReactNode } from 'react'
import { fillText } from '../store/changes-store.ts'
import css from './PageTabs.module.css'

/** Visible strings of this module; moved into the locale namespace in T7. */
export const TEXT = {
  tabsLabel: 'Git 页面',
  log: '日志',
  commit: '提交',
  badgeTitle: '{count} 个未提交文件',
} as const

export type WorkbenchPage = 'log' | 'commit'

export const WORKBENCH_PAGES: readonly WorkbenchPage[] = ['log', 'commit']

const LABEL: Record<WorkbenchPage, string> = { log: TEXT.log, commit: TEXT.commit }

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
}

export function PageTabs({ page, onChange, uncommittedCount }: PageTabsProps): ReactNode {
  const badge = badgeText(uncommittedCount)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = adjacentPage(page, event.key)
    if (next === null) return
    event.preventDefault()
    onChange(next)
    const target = event.currentTarget.querySelector<HTMLElement>(`[data-page="${next}"]`)
    target?.focus()
  }
  return (
    <div role="tablist" aria-label={TEXT.tabsLabel} className={css.tabs} onKeyDown={onKeyDown}>
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
            className={selected ? `${css.tab} ${css.selected}` : css.tab}
            data-page={candidate}
            onClick={() => { if (!selected) onChange(candidate) }}
          >
            {LABEL[candidate]}
            {candidate === 'commit' && badge !== null
              ? (
                  <span className={css.badge} title={fillText(TEXT.badgeTitle, { count: uncommittedCount })} data-badge={uncommittedCount}>
                    {badge}
                  </span>
                )
              : null}
          </button>
        )
      })}
    </div>
  )
}
