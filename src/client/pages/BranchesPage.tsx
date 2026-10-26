// Level 0 "Branches" page (design §8.3, plan A3 T7): search over branches and quick actions,
// quick-action rows, grouped branch tree (local / remote / tags), `›` and right-click action menu,
// single click selects and double click checks out. Writes go through `onAction` (BranchActionRunner).
import { useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { BranchEntry, BranchesValue, GitError, RepoOperation } from '../../shared/protocol.ts'
import { activeFocusTarget } from '../focus.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { OPERATION_KEY } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { BranchContextMenu } from './BranchPanel.tsx'
import { branchActions, doubleClickAction, matchesQuery, quickActions } from './branch-actions.ts'
import type { BranchActionContext, BranchActionId, QuickActionId, QuickActionItem } from './branch-actions.ts'
import { formatAheadBehind, groupBranches } from './branch-store.ts'
import type { BranchGroup, BranchGroupKind, BranchRow, CollapsedGroups } from './branch-store.ts'
import css from './BranchesPage.module.css'

export interface BranchesPageProps {
  value: BranchesValue | null
  loading?: boolean
  error?: GitError | null
  context: BranchActionContext
  search: string
  collapsedGroups: Readonly<CollapsedGroups>
  collapsedDirs: Readonly<Record<string, boolean>>
  flat: boolean
  /** A fetch is running (the button shows it and cannot be pressed again). */
  fetching?: boolean
  onSearchChange: (search: string) => void
  onToggleGroup: (kind: BranchGroupKind) => void
  onToggleDirectory: (path: string) => void
  /** Branch / tag actions from the menu and the double click. `trigger` is the clicked control. */
  onAction: (id: BranchActionId, entry: BranchEntry, trigger: FocusTarget | null) => void
  onQuickAction: (id: QuickActionId, trigger: FocusTarget | null) => void
  onFetch: (trigger: FocusTarget | null) => void
  onRetry?: () => void
  onOpenConsole?: () => void
}

/** Quick actions whose translated label matches the query. */
export function filterQuickActions(items: readonly QuickActionItem[], query: string, t: Translate): QuickActionItem[] {
  return items.filter(item => matchesQuery(t(item.label.key, item.label.params), query))
}

/** The HEAD group is only useful when detached (the current branch already tops the local group). */
function pageGroups(
  value: BranchesValue | null,
  options: Pick<BranchesPageProps, 'search' | 'flat' | 'collapsedGroups' | 'collapsedDirs'>,
): BranchGroup[] {
  return groupBranches(value, {
    search: options.search,
    flat: options.flat,
    collapsedGroups: options.collapsedGroups,
    collapsedDirs: options.collapsedDirs,
  }).filter(group => group.kind !== 'head' || value?.head.detached === true)
}

interface MenuState { entry: BranchEntry; x: number; y: number; trigger: FocusTarget | null }

function triggerOf(event: MouseEvent): FocusTarget | null {
  const element = event.currentTarget
  return typeof HTMLElement !== 'undefined' && element instanceof HTMLElement ? element : activeFocusTarget()
}

export interface BranchAbortConfirmProps {
  t: Translate
  operation: Exclude<RepoOperation, null>
  onCancel: () => void
  onConfirm: (trigger: FocusTarget | null) => void
}

/** Abort confirmation of the quick actions, worded like the banner's (carry 7). */
export function BranchAbortConfirm({ t, operation, onCancel, onConfirm }: BranchAbortConfirmProps): ReactNode {
  const name = t(OPERATION_KEY[operation])
  return (
    <div className={css.confirm} role="alert" data-abort-confirm>
      <span>{t('banner.abort.confirm', { operation: name })}</span>
      <span className={css.confirmActions}>
        <Button onClick={onCancel}>{t('banner.abort.cancel')}</Button>
        <Button tone="danger" onClick={(event) => { onConfirm(event.currentTarget) }} data-danger>
          {t('banner.abort.confirmButton', { operation: name })}
        </Button>
      </span>
    </div>
  )
}

export function BranchesPage(props: BranchesPageProps): ReactNode {
  const t = useT()
  const { value, context, search, loading = false, error = null, fetching = false } = props
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirmingAbort, setConfirmingAbort] = useState(false)

  const groups = useMemo(
    () => pageGroups(value, { search, flat: props.flat, collapsedGroups: props.collapsedGroups, collapsedDirs: props.collapsedDirs }),
    [value, search, props.flat, props.collapsedGroups, props.collapsedDirs],
  )
  const quick = filterQuickActions(quickActions(context), search, t)
  const searching = search.trim() !== ''
  const noBranchMatch = groups.every(group => group.total === 0)
  const noMatch = searching && quick.length === 0 && noBranchMatch && value !== null

  const runQuick = (item: QuickActionItem, trigger: FocusTarget | null): void => {
    if (item.disabledReason !== undefined) return
    if (item.id === 'abort') {
      // Abort throws away what the operation has done: ask once more before sending it.
      setConfirmingAbort(true)
      return
    }
    setConfirmingAbort(false)
    props.onQuickAction(item.id, trigger)
  }

  let tree: ReactNode
  if (value === null && error !== null) {
    tree = (
      <EmptyState
        error
        title={t('branch.loadFailed')}
        hint={t('error.detail', { code: error.code, message: error.message })}
        action={{ label: t('action.retry'), onClick: props.onRetry ?? (() => {}) }}
      />
    )
  } else if (value === null) {
    tree = <div className={css.message} aria-busy={loading}>{t(loading ? 'state.loading' : 'branch.empty')}</div>
  } else if (noMatch) {
    tree = <EmptyState title={t('branch.page.noMatch')} hint={t('branch.noMatch.hint', { query: search.trim() })} />
  } else {
    tree = (
      <div role="tree" aria-label={t('branch.page.branches')} className={css.tree}>
        {groups.map((group) => {
          if (searching && group.total === 0) return null
          return (
            <div key={group.kind} role="group" aria-label={group.label} data-group={group.kind} className={css.group}>
              <button
                type="button"
                className={css.groupHeader}
                data-group-toggle={group.kind}
                aria-expanded={!group.collapsed}
                onClick={() => props.onToggleGroup(group.kind)}
              >
                <span className={css.chevron} aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>
                <span>{group.label}</span>
                <span className={css.count}>{group.total}</span>
              </button>
              {group.rows.map(row => (
                <PageRow
                  key={row.key}
                  row={row}
                  selected={row.entry !== undefined && row.entry.ref === selected}
                  onSelect={entry => setSelected(entry.ref)}
                  onToggleDirectory={props.onToggleDirectory}
                  onCheckout={(entry, trigger) => {
                    if (doubleClickAction(entry, context) === 'checkout') props.onAction('checkout', entry, trigger)
                  }}
                  onOpenMenu={(entry, x, y, trigger) => setMenu({ entry, x, y, trigger })}
                />
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <section className={css.page} aria-label={t('branch.page.title')}>
      <div className={css.header}>
        <input
          type="search"
          className={css.search}
          placeholder={t('branch.page.search')}
          aria-label={t('branch.page.search')}
          value={search}
          onChange={event => props.onSearchChange(event.target.value)}
        />
        <Button
          disabled={fetching || !context.writable}
          title={context.writable ? undefined : t('branch.disabled.readOnly')}
          onClick={event => props.onFetch(event.currentTarget)}
          data-fetch
        >
          {fetching ? t('branch.page.fetching') : t('branch.page.fetch')}
        </Button>
      </div>
      {context.writable ? null : <div className={css.notice} role="status">{t('branch.page.readOnly')}</div>}
      {value !== null && error !== null
        ? (
            <div role="alert" className={css.inlineError}>
              <span>{t('refresh.failed', { code: error.code })}</span>
              {props.onRetry === undefined ? null : <Button onClick={props.onRetry}>{t('action.retry')}</Button>}
              {props.onOpenConsole === undefined ? null : <Button onClick={props.onOpenConsole}>{t('branch.openConsole')}</Button>}
            </div>
          )
        : null}
      <div className={css.scroll}>
        {quick.length === 0
          ? null
          : (
              <div className={css.quick} role="group" aria-label={t('branch.page.actions')}>
                {quick.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${css.quickItem} ${item.disabledReason === undefined ? '' : css.quickDisabled}`}
                    data-quick={item.id}
                    {...(item.danger === true ? { 'data-danger': true } : {})}
                    {...(item.disabledReason === undefined
                      ? {}
                      : { 'aria-disabled': true, title: t(item.disabledReason.key, item.disabledReason.params) })}
                    onClick={event => runQuick(item, event.currentTarget)}
                  >
                    {t(item.label.key, item.label.params)}
                  </button>
                ))}
              </div>
            )}
        {confirmingAbort && context.operation !== null
          ? (
              <BranchAbortConfirm
                t={t}
                operation={context.operation}
                onCancel={() => setConfirmingAbort(false)}
                onConfirm={(trigger) => {
                  setConfirmingAbort(false)
                  props.onQuickAction('abort', trigger)
                }}
              />
            )
          : null}
        {tree}
      </div>
      {value?.truncated === true ? <div className={css.footnote}>{t('branch.truncated')}</div> : null}
      {menu === null
        ? null
        : (
            <BranchContextMenu
              entry={menu.entry}
              items={branchActions(menu.entry, context)}
              position={{ x: menu.x, y: menu.y }}
              onClose={() => setMenu(null)}
              onSelect={(id) => {
                const { entry, trigger } = menu
                setMenu(null)
                props.onAction(id, entry, trigger)
              }}
            />
          )}
    </section>
  )
}

interface PageRowProps {
  row: BranchRow
  selected: boolean
  onSelect: (entry: BranchEntry) => void
  onToggleDirectory: (path: string) => void
  onCheckout: (entry: BranchEntry, trigger: FocusTarget | null) => void
  onOpenMenu: (entry: BranchEntry, x: number, y: number, trigger: FocusTarget | null) => void
}

function PageRow({ row, selected, onSelect, onToggleDirectory, onCheckout, onOpenMenu }: PageRowProps): ReactNode {
  const t = useT()
  const indent = { '--git-tree-depth': row.depth } as CSSProperties
  if (row.kind === 'directory') {
    const expanded = row.directoryCollapsed !== true
    const toggle = (): void => { if (row.path !== undefined) onToggleDirectory(row.path) }
    return (
      <div
        role="treeitem"
        tabIndex={-1}
        aria-level={row.depth + 2}
        aria-expanded={expanded}
        data-kind="directory"
        data-path={row.path}
        className={css.row}
        style={indent}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } }}
      >
        <span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={css.name}>{row.label}</span>
        <span className={css.count}>{row.childCount}</span>
      </div>
    )
  }
  const entry = row.entry
  const aheadBehind = formatAheadBehind(row.ahead, row.behind)
  const classes = [css.row, row.current ? css.current : '', selected ? css.selected : ''].filter(Boolean).join(' ')
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={row.depth + 2}
      aria-selected={selected}
      data-kind="branch"
      data-branch-name={entry?.name}
      data-current={row.current}
      className={classes}
      style={indent}
      title={entry === undefined ? row.label : t('branch.page.row.title', { ref: entry.ref })}
      onClick={entry === undefined ? undefined : () => onSelect(entry)}
      onDoubleClick={entry === undefined ? undefined : event => onCheckout(entry, triggerOf(event))}
      onContextMenu={entry === undefined
        ? undefined
        : (event) => {
            event.preventDefault()
            onSelect(entry)
            onOpenMenu(entry, event.clientX, event.clientY, triggerOf(event))
          }}
      onKeyDown={(event) => {
        if (entry !== undefined && event.key === 'Enter') { event.preventDefault(); onSelect(entry) }
      }}
    >
      <span className={css.name}>{row.label}</span>
      {row.detached ? <span className={css.detachedNote}>detached HEAD</span> : null}
      {row.current ? <span className={css.check} aria-label={t('branch.current')}>✓</span> : null}
      {row.upstream === undefined ? null : <span className={css.upstream}>{row.upstream}</span>}
      {aheadBehind === '' ? null : <span className={css.aheadBehind}>{aheadBehind}</span>}
      {entry === undefined
        ? null
        : (
            <button
              type="button"
              className={css.rowMenu}
              data-row-menu
              aria-haspopup="menu"
              aria-label={t('branch.rowMenu')}
              title={t('branch.rowMenu')}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(entry)
                const rect = event.currentTarget.getBoundingClientRect()
                onOpenMenu(entry, rect.left, rect.bottom, triggerOf(event))
              }}
            >
              ›
            </button>
          )}
    </div>
  )
}
