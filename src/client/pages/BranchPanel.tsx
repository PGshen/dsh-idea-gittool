// 分支面板（设计 §5.4、§8.1.4）：HEAD → Local → Remote → Tags 分组树。
// Wide 档为可收起的常驻左栏；Standard 档为抽屉，Compact 档为全高覆盖页（都点外部/Esc 关闭）。
// 单击导航、双击过滤；右键菜单来自 branchActions（A3 T7：签出、新建、合并、重命名、删除等），
// 写动作经 onAction 交给工作台的 BranchActionRunner。
// Row-level focus (I-1): right click, ArrowRight or Shift+F10 opens a row's menu; closing it refocuses the row.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { BranchEntry, BranchesValue, GitError } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { activeFocusTarget, restoreFocus } from '../focus.ts'
import type { FocusTarget } from '../focus.ts'
import { branchActions } from './branch-actions.ts'
import type { BranchActionContext, BranchActionId, BranchActionItem } from './branch-actions.ts'
import {
  createBranchActivator,
  formatAheadBehind,
  groupBranches,
} from './branch-store.ts'
import type { BranchGroup, BranchGroupKind, BranchRow, CollapsedGroups, PanelMode } from './branch-store.ts'
import css from './BranchPanel.module.css'
import { finishRowMenu, moveTreeFocus, rowMenuAnchor, rowOf, treeRowKeyAction } from './menu-focus.ts'
import { useFloatingMenu } from './menu-position.ts'
import type { MenuAnchor } from './menu-position.ts'

export interface BranchPanelProps {
  value: BranchesValue | null
  mode: PanelMode
  /** Standard/Compact：抽屉/覆盖页是否打开；Wide 档忽略。 */
  open: boolean
  search: string
  collapsedGroups: Readonly<CollapsedGroups>
  collapsedDirs: Readonly<Record<string, boolean>>
  flat: boolean
  /** 单击：日志导航到 entry.sha（不改过滤）。 */
  onNavigate: (entry: BranchEntry) => void
  /** 双击：日志过滤到该分支（entry.name / entry.ref）。 */
  onFilter: (entry: BranchEntry) => void
  loading?: boolean
  error?: GitError | null
  /** 当前日志选中/定位的 ref，用于高亮行。 */
  selectedRef?: string | null
  /** Wide 档左栏是否收起。 */
  collapsed?: boolean
  onToggleCollapse?: () => void
  /** 关闭抽屉/覆盖页（Standard/Compact）。 */
  onClose?: () => void
  onSearchChange?: (search: string) => void
  onToggleGroup?: (kind: BranchGroupKind) => void
  onToggleDirectory?: (path: string) => void
  onToggleFlat?: () => void
  onRetry?: () => void
  onOpenConsole?: () => void
  /** 复制文本；默认走 navigator.clipboard。 */
  onCopy?: (text: string) => void
  /** 菜单可用性所需的仓库状态；未传时按只读处理（写动作显示原因而不可用）。 */
  actionContext?: BranchActionContext
  /** 菜单里除复制/跳转/过滤外的动作；`trigger` 是右键的那一行（关闭菜单后焦点回到它）。 */
  onAction?: (id: BranchActionId, entry: BranchEntry, trigger: FocusTarget | null) => void
}

const READ_ONLY_CONTEXT: BranchActionContext = { writable: false, operation: null, current: null, dirty: false }

/** 默认复制实现：浏览器剪贴板，不可用时静默忽略。 */
export function copyText(text: string): void {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => {})
}

const KIND_ICON: Record<'head' | 'local' | 'remote' | 'tag' | 'detached', string> = {
  head: '◉',
  local: '⎇',
  remote: '☁',
  tag: '⌂',
  detached: '◎',
}

function rowIcon(group: BranchGroupKind, row: BranchRow): string {
  if (row.detached) return KIND_ICON.detached
  if (group === 'head') return KIND_ICON.head
  if (row.entry?.kind === 'remote') return KIND_ICON.remote
  if (row.entry?.kind === 'tag') return KIND_ICON.tag
  return KIND_ICON.local
}

interface MenuState { entry: BranchEntry; anchor: MenuAnchor; trigger: FocusTarget | null }

/** 抽屉内 Esc：有搜索词先清空（同 input[type=search] 习惯），否则关闭抽屉/覆盖页。 */
export function drawerEscapeAction(search: string): 'clear-search' | 'close' {
  return search.trim() === '' ? 'close' : 'clear-search'
}

export function BranchPanel(props: BranchPanelProps): ReactNode {
  const t = useT()
  const { mode, open, collapsed = false } = props
  if (mode !== 'wide' && !open) return null
  if (mode === 'wide' && collapsed) {
    return (
      <aside className={`${css.panel} ${css.wide} ${css.collapsedRail}`} data-mode="wide" data-collapsed="true">
        <button
          type="button"
          className={css.railButton}
          aria-expanded="false"
          aria-label={t('branch.expand')}
          title={t('branch.expand')}
          onClick={props.onToggleCollapse}
        >
          ⎇
        </button>
      </aside>
    )
  }
  if (mode === 'wide') {
    return (
      <aside className={`${css.panel} ${css.wide}`} data-mode="wide" data-collapsed="false" aria-label={t('branch.panel')}>
        <BranchPanelBody {...props} />
      </aside>
    )
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (drawerEscapeAction(props.search) === 'clear-search') props.onSearchChange?.('')
    else props.onClose?.()
  }
  return (
    <div className={css.overlay} data-mode={mode}>
      {mode === 'standard'
        ? <div className={css.backdrop} aria-hidden="true" onClick={props.onClose} />
        : null}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('branch.panel')}
        className={`${css.panel} ${mode === 'compact' ? css.compact : css.drawer}`}
        onKeyDown={onKeyDown}
      >
        <BranchPanelBody {...props} />
      </div>
    </div>
  )
}

function BranchPanelBody(props: BranchPanelProps): ReactNode {
  const {
    value, mode, search, collapsedGroups, collapsedDirs, flat, loading = false, error = null,
  } = props
  const t = useT()
  const [menu, setMenu] = useState<MenuState | null>(null)
  // 抽屉/覆盖页打开即把焦点移进来，Esc 与键盘操作才落在面板内（Wide 档常驻，不抢焦点）。
  const autofocus = mode !== 'wide'
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autofocus) searchRef.current?.focus()
  }, [autofocus])
  // 回调总取最新 props，activator 只建一次。
  const latest = useRef(props)
  latest.current = props
  const activator = useMemo(() => createBranchActivator({
    onNavigate: (entry) => {
      latest.current.onNavigate(entry)
      if (latest.current.mode !== 'wide') latest.current.onClose?.()
    },
    onFilter: (entry) => {
      latest.current.onFilter(entry)
      if (latest.current.mode !== 'wide') latest.current.onClose?.()
    },
  }), [])
  useEffect(() => () => activator.cancel(), [activator])

  const groups = useMemo(
    () => groupBranches(value, { search, flat, collapsedGroups, collapsedDirs }),
    [value, search, flat, collapsedGroups, collapsedDirs],
  )
  const copy = props.onCopy ?? copyText
  const searching = search.trim() !== ''
  const noMatch = searching && groups.length > 0 && groups.every(group => group.total === 0)

  let content: ReactNode
  if (value === null && error !== null) {
    content = (
      <EmptyState
        error
        title={t('branch.loadFailed')}
        hint={t('error.detail', { code: error.code, message: error.message })}
        action={{ label: t('action.retry'), onClick: props.onRetry ?? (() => {}) }}
      />
    )
  } else if (value === null) {
    content = <div className={css.message} aria-busy={loading}>{t(loading ? 'state.loading' : 'branch.empty')}</div>
  } else if (noMatch) {
    content = <EmptyState title={t('branch.noMatch')} hint={t('branch.noMatch.hint', { query: search.trim() })} />
  } else {
    content = (
      <div role="tree" aria-label={t('branch.panel')} className={css.tree}>
        {groups.map(group => (
          <BranchGroupView
            key={group.kind}
            group={group}
            searching={searching}
            selectedRef={props.selectedRef ?? null}
            onToggleGroup={props.onToggleGroup}
            onToggleDirectory={props.onToggleDirectory}
            onClickEntry={activator.onClick}
            onDoubleClickEntry={activator.onDoubleClick}
            onOpenMenu={(entry, anchor, row) => {
              // The row owns focus (I-1): it is focused first and the menu returns focus to it.
              restoreFocus(row)
              setMenu({ entry, anchor, trigger: row ?? activeFocusTarget() })
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <div className={css.header}>
        <input
          ref={searchRef}
          type="search"
          {...(autofocus ? { 'data-autofocus': 'true' } : {})}
          className={css.search}
          placeholder={t('branch.search')}
          aria-label={t('branch.search')}
          value={search}
          onChange={event => props.onSearchChange?.(event.target.value)}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-pressed={flat}
          title={t(flat ? 'branch.grouped' : 'branch.flat')}
          aria-label={t('branch.flat')}
          onClick={props.onToggleFlat}
        >
          ≡
        </button>
        {mode === 'wide'
          ? null
          : (
              <button type="button" className={css.iconButton} aria-label={t('branch.close')} title={t('action.close')} onClick={props.onClose}>
                ✕
              </button>
            )}
      </div>
      {value !== null && error !== null
        ? (
            <div role="alert" className={css.inlineError}>
              <span>{t('refresh.failed', { code: error.code })}</span>
              {props.onRetry === undefined ? null : <Button onClick={props.onRetry}>{t('action.retry')}</Button>}
              {props.onOpenConsole === undefined ? null : <Button onClick={props.onOpenConsole}>{t('branch.openConsole')}</Button>}
            </div>
          )
        : null}
      <div className={css.body}>{content}</div>
      {value?.truncated === true ? <div className={css.footnote}>{t('branch.truncated')}</div> : null}
      {mode === 'wide' && props.onToggleCollapse !== undefined
        ? (
            <div className={css.footer}>
              <button type="button" className={css.footerButton} aria-expanded="true" onClick={props.onToggleCollapse}>
                {t('branch.collapse')}
              </button>
            </div>
          )
        : null}
      {menu === null
        ? null
        : (
            <BranchContextMenu
              entry={menu.entry}
              items={branchActions(menu.entry, props.actionContext ?? READ_ONLY_CONTEXT)}
              anchor={menu.anchor}
              onClose={() => {
                setMenu(null)
                finishRowMenu(menu.trigger)
              }}
              onSelect={(id) => {
                const { entry, trigger } = menu
                setMenu(null)
                finishRowMenu(trigger, (row) => {
                  if (id === 'copyName') copy(entry.name)
                  else if (id === 'copyRef') copy(entry.ref)
                  else if (id === 'showInLog') { activator.cancel(); latest.current.onNavigate(entry) }
                  else if (id === 'filterLog') activator.onDoubleClick(entry)
                  else latest.current.onAction?.(id, entry, row)
                })
              }}
            />
          )}
    </>
  )
}

interface BranchGroupViewProps {
  group: BranchGroup
  searching: boolean
  selectedRef: string | null
  onToggleGroup: ((kind: BranchGroupKind) => void) | undefined
  onToggleDirectory: ((path: string) => void) | undefined
  onClickEntry: (entry: BranchEntry) => void
  onDoubleClickEntry: (entry: BranchEntry) => void
  /** Right click or the row's menu key: open the menu at `anchor`; `row` is the row element. */
  onOpenMenu: (entry: BranchEntry, anchor: MenuAnchor, row: FocusTarget | null) => void
}

function BranchGroupView({ group, searching, selectedRef, ...handlers }: BranchGroupViewProps): ReactNode {
  // 搜索时隐藏没有命中的分组，减少噪音。
  if (searching && group.total === 0) return null
  return (
    <div role="group" aria-label={group.label} data-group={group.kind} className={css.group}>
      <button
        type="button"
        className={css.groupHeader}
        data-group-toggle={group.kind}
        aria-expanded={!group.collapsed}
        onClick={() => handlers.onToggleGroup?.(group.kind)}
      >
        <span className={css.chevron} aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>
        <span>{group.label}</span>
        <span className={css.count}>{group.total}</span>
      </button>
      {group.rows.map(row => (
        <BranchRowView key={row.key} group={group.kind} row={row} selected={selectedRef !== null && row.entry?.ref === selectedRef} {...handlers} />
      ))}
    </div>
  )
}

interface BranchRowViewProps extends Omit<BranchGroupViewProps, 'group' | 'searching' | 'selectedRef' | 'onToggleGroup'> {
  group: BranchGroupKind
  row: BranchRow
  selected: boolean
}

function BranchRowView({ group, row, selected, onToggleDirectory, onClickEntry, onDoubleClickEntry, onOpenMenu }: BranchRowViewProps): ReactNode {
  const t = useT()
  const indent = { '--git-tree-depth': row.depth } as CSSProperties
  if (row.kind === 'directory') {
    const expanded = row.directoryCollapsed !== true
    const toggle = (): void => { if (row.path !== undefined) onToggleDirectory?.(row.path) }
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
        onKeyDown={event => directoryRowKey(event, expanded, toggle)}
      >
        <span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={css.name}>{row.label}</span>
        <span className={css.count}>{row.childCount}</span>
      </div>
    )
  }
  const entry = row.entry
  const aheadBehind = formatAheadBehind(row.ahead, row.behind)
  const classes = [css.row, row.current ? css.current : '', row.detached ? css.detached : '', selected ? css.selected : '']
    .filter(Boolean).join(' ')
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={row.depth + 2}
      aria-selected={selected}
      data-kind="branch"
      data-branch-name={entry?.name}
      data-current={row.current}
      data-head={row.head}
      data-detached={row.detached}
      data-upstream={row.upstream}
      data-ahead={row.ahead}
      data-behind={row.behind}
      className={classes}
      style={indent}
      title={entry === undefined ? row.label : t('branch.row.title', { ref: entry.ref })}
      onClick={entry === undefined ? undefined : () => onClickEntry(entry)}
      onDoubleClick={entry === undefined ? undefined : () => onDoubleClickEntry(entry)}
      onContextMenu={entry === undefined
        ? undefined
        : (event) => {
            event.preventDefault()
            onOpenMenu(entry, { kind: 'point', x: event.clientX, y: event.clientY }, rowOf(event.currentTarget))
          }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (entry !== undefined && event.key === 'Enter') {
          event.preventDefault()
          if (event.shiftKey) onDoubleClickEntry(entry)
          else onClickEntry(entry)
          return
        }
        const action = treeRowKeyAction({ kind: 'branch', hasMenu: entry !== undefined }, event)
        if (action === null) return
        event.preventDefault()
        if (action === 'open-menu' && entry !== undefined) onOpenMenu(entry, rowMenuAnchor(event.currentTarget), event.currentTarget)
        else if (action === 'next-row' || action === 'previous-row') moveTreeFocus(event.currentTarget, action === 'next-row' ? 1 : -1)
      }}
    >
      <span className={css.icon} aria-hidden="true">{rowIcon(group, row)}</span>
      <span className={css.name}>{row.label}</span>
      {row.detached ? <span className={css.detachedNote}>{t('branch.detachedNote')}</span> : null}
      {row.current ? <span className={css.check} aria-label={t('branch.current')}>✓</span> : null}
      {row.upstream === undefined ? null : <span className={css.upstream}>{row.upstream}</span>}
      {aheadBehind === '' ? null : <span className={css.aheadBehind}>{aheadBehind}</span>}
    </div>
  )
}

/**
 * Keys on a directory row (shared with the Branches page): Enter / Space toggle, ArrowRight expands,
 * ArrowLeft collapses, ArrowUp / ArrowDown move between rows. Directory rows never open a menu.
 */
export function directoryRowKey(event: KeyboardEvent<HTMLElement>, expanded: boolean, toggle: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggle()
    return
  }
  const action = treeRowKeyAction({ kind: 'directory', expanded, hasMenu: false }, event)
  if (action === null) return
  event.preventDefault()
  if (action === 'expand' || action === 'collapse') toggle()
  else if (action === 'next-row' || action === 'previous-row') moveTreeFocus(event.currentTarget, action === 'next-row' ? 1 : -1)
}

export interface BranchContextMenuProps {
  entry: BranchEntry
  /** 来自 `branchActions(entry, context)`；不可用项带原因，仍然显示。 */
  items: BranchActionItem[]
  onSelect: (id: BranchActionId) => void
  onClose?: () => void
  /** 打开位置（右键点或 `›` 按钮）；渲染后量尺寸并收进视口与 Git 面板。不传时按文档流渲染（测试/静态渲染）。 */
  anchor?: MenuAnchor
}

/** 分支/标签右键菜单（分支面板与分支页共用）。 */
export function BranchContextMenu({ entry, items, onSelect, onClose, anchor }: BranchContextMenuProps): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  // Placement, focus once placed, arrow keys and closing; an inline onClose does not re-run them (I-1).
  const { style, onKeyDown } = useFloatingMenu(ref, anchor, onClose)
  const nodes: ReactNode[] = []
  let previousSection: number | null = null
  for (const item of items) {
    if (previousSection !== null && item.section !== previousSection) {
      nodes.push(<div key={`sep-${item.id}`} role="separator" className={css.menuSeparator} />)
    }
    previousSection = item.section
    const reason = item.disabledReason === undefined ? null : t(item.disabledReason.key, item.disabledReason.params)
    nodes.push(
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className={`${css.menuItem} ${reason === null ? '' : css.menuItemDisabled}`}
        data-action={item.id}
        {...(item.danger === true ? { 'data-danger': true } : {})}
        {...(reason === null ? {} : { 'aria-disabled': true, title: reason })}
        onClick={() => { if (reason === null) onSelect(item.id) }}
      >
        <span>{t(item.label.key, item.label.params)}</span>
        {reason === null ? null : <span className={css.menuReason}>{reason}</span>}
      </button>,
    )
  }
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('branch.menu', { name: entry.name })}
      className={`${css.menu} ${anchor === undefined ? '' : css.menuFloating}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      {nodes}
    </div>
  )
}
