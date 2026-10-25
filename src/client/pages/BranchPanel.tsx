// 分支面板（设计 §5.4、§8.1.4）：HEAD → Local → Remote → Tags 分组树。
// Wide 档为可收起的常驻左栏；Standard 档为抽屉，Compact 档为全高覆盖页（都点外部/Esc 关闭）。
// A1 只读：单击导航、双击过滤、右键只有复制与跳转；签出等写动作留到 A3。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { BranchEntry, BranchesValue, GitError } from '../../shared/protocol.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import {
  createBranchActivator,
  formatAheadBehind,
  groupBranches,
} from './branch-store.ts'
import type { BranchGroup, BranchGroupKind, BranchRow, CollapsedGroups, PanelMode } from './branch-store.ts'
import css from './BranchPanel.module.css'

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
}

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

interface MenuState { entry: BranchEntry; x: number; y: number }

export function BranchPanel(props: BranchPanelProps): ReactNode {
  const { mode, open, collapsed = false } = props
  if (mode !== 'wide' && !open) return null
  if (mode === 'wide' && collapsed) {
    return (
      <aside className={`${css.panel} ${css.wide} ${css.collapsedRail}`} data-mode="wide" data-collapsed="true">
        <button
          type="button"
          className={css.railButton}
          aria-expanded="false"
          aria-label="展开分支面板"
          title="展开分支面板"
          onClick={props.onToggleCollapse}
        >
          ⎇
        </button>
      </aside>
    )
  }
  if (mode === 'wide') {
    return (
      <aside className={`${css.panel} ${css.wide}`} data-mode="wide" data-collapsed="false" aria-label="分支">
        <BranchPanelBody {...props} />
      </aside>
    )
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      props.onClose?.()
    }
  }
  return (
    <div className={css.overlay} data-mode={mode}>
      {mode === 'standard'
        ? <div className={css.backdrop} aria-hidden="true" onClick={props.onClose} />
        : null}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="分支"
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
  const [menu, setMenu] = useState<MenuState | null>(null)
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
        title="读取分支失败"
        hint={`${error.code}：${error.message}`}
        action={{ label: '重试', onClick: props.onRetry ?? (() => {}) }}
      />
    )
  } else if (value === null) {
    content = <div className={css.message} aria-busy={loading}>{loading ? '读取中…' : '暂无分支数据'}</div>
  } else if (noMatch) {
    content = <EmptyState title="没有匹配的分支" hint={`没有名称包含「${search.trim()}」的分支或标签`} />
  } else {
    content = (
      <div role="tree" aria-label="分支" className={css.tree}>
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
            onContextMenu={(entry, event) => {
              event.preventDefault()
              setMenu({ entry, x: event.clientX, y: event.clientY })
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
          type="search"
          className={css.search}
          placeholder="搜索分支"
          aria-label="搜索分支"
          value={search}
          onChange={event => props.onSearchChange?.(event.target.value)}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-pressed={flat}
          title={flat ? '按目录分组' : '扁平显示'}
          aria-label="扁平显示"
          onClick={props.onToggleFlat}
        >
          ≡
        </button>
        {mode === 'wide'
          ? null
          : (
              <button type="button" className={css.iconButton} aria-label="关闭分支面板" title="关闭" onClick={props.onClose}>
                ✕
              </button>
            )}
      </div>
      {value !== null && error !== null
        ? (
            <div role="alert" className={css.inlineError}>
              <span>刷新失败：{error.code}</span>
              {props.onRetry === undefined ? null : <Button onClick={props.onRetry}>重试</Button>}
              {props.onOpenConsole === undefined ? null : <Button onClick={props.onOpenConsole}>打开控制台</Button>}
            </div>
          )
        : null}
      <div className={css.body}>{content}</div>
      {value?.truncated === true ? <div className={css.footnote}>分支过多，列表已截断</div> : null}
      {mode === 'wide' && props.onToggleCollapse !== undefined
        ? (
            <div className={css.footer}>
              <button type="button" className={css.footerButton} aria-expanded="true" onClick={props.onToggleCollapse}>
                « 收起
              </button>
            </div>
          )
        : null}
      {menu === null
        ? null
        : (
            <BranchContextMenu
              entry={menu.entry}
              position={{ x: menu.x, y: menu.y }}
              onClose={() => setMenu(null)}
              onCopyName={() => { copy(menu.entry.name); setMenu(null) }}
              onCopyRef={() => { copy(menu.entry.ref); setMenu(null) }}
              onNavigate={() => { activator.cancel(); latest.current.onNavigate(menu.entry); setMenu(null) }}
              onFilter={() => { activator.onDoubleClick(menu.entry); setMenu(null) }}
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
  onContextMenu: (entry: BranchEntry, event: MouseEvent) => void
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

function BranchRowView({ group, row, selected, onToggleDirectory, onClickEntry, onDoubleClickEntry, onContextMenu }: BranchRowViewProps): ReactNode {
  const indent = { '--dsw-git-tree-depth': row.depth } as CSSProperties
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
      title={entry === undefined ? row.label : `${entry.ref}\n单击：定位到该分支 · 双击：按该分支过滤`}
      onClick={entry === undefined ? undefined : () => onClickEntry(entry)}
      onDoubleClick={entry === undefined ? undefined : () => onDoubleClickEntry(entry)}
      onContextMenu={entry === undefined ? undefined : event => onContextMenu(entry, event)}
      onKeyDown={(event) => {
        if (entry === undefined || event.key !== 'Enter') return
        event.preventDefault()
        if (event.shiftKey) onDoubleClickEntry(entry)
        else onClickEntry(entry)
      }}
    >
      <span className={css.icon} aria-hidden="true">{rowIcon(group, row)}</span>
      <span className={css.name}>{row.label}</span>
      {row.detached ? <span className={css.detachedNote}>detached HEAD</span> : null}
      {row.current ? <span className={css.check} aria-label="当前分支">✓</span> : null}
      {row.upstream === undefined ? null : <span className={css.upstream}>{row.upstream}</span>}
      {aheadBehind === '' ? null : <span className={css.aheadBehind}>{aheadBehind}</span>}
    </div>
  )
}

export interface BranchContextMenuProps {
  entry: BranchEntry
  onCopyName: () => void
  onCopyRef: () => void
  /** 跳转：日志定位到该分支 HEAD。 */
  onNavigate: () => void
  /** 过滤：日志只看该分支（可选）。 */
  onFilter?: () => void
  onClose?: () => void
  /** 视口坐标；不传时按文档流渲染（测试/静态渲染）。 */
  position?: { x: number; y: number }
}

/** 分支右键菜单（A1 只读子集）。 */
export function BranchContextMenu({ entry, onCopyName, onCopyRef, onNavigate, onFilter, onClose, position }: BranchContextMenuProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (onClose === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])
  const style = position === undefined ? undefined : { left: `${position.x}px`, top: `${position.y}px` }
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${entry.name} 操作`}
      className={`${css.menu} ${position === undefined ? '' : css.menuFloating}`}
      style={style}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.() } }}
    >
      <button type="button" role="menuitem" className={css.menuItem} onClick={onNavigate}>跳转到 HEAD</button>
      {onFilter === undefined
        ? null
        : <button type="button" role="menuitem" className={css.menuItem} onClick={onFilter}>按此分支过滤日志</button>}
      <div role="separator" className={css.menuSeparator} />
      <button type="button" role="menuitem" className={css.menuItem} onClick={onCopyName}>复制名称</button>
      <button type="button" role="menuitem" className={css.menuItem} onClick={onCopyRef}>复制完整引用</button>
    </div>
  )
}
