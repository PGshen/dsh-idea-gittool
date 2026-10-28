// Commit page changes tree (design §8.2.2): grouped tri-state tree, search, keyboard and context menu.
// State lives in the injected ChangesStore; write actions are delegated to the workbench via callbacks.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import { useT } from '../i18n.tsx'
import { buildChangeGroups } from '../store/changes-store.ts'
import type {
  ChangeEntry,
  ChangeGroupView,
  ChangeTreeFile,
  ChangeTreeNode,
  ChangesState,
  ChangesStore,
  CheckState,
} from '../store/changes-store.ts'
import { copyText } from './BranchPanel.tsx'
import css from './ChangesTree.module.css'
import { fileActions } from './file-actions.ts'


export type DiffOpenScope = 'worktree' | 'staged'

export interface ChangesTreeProps {
  state: ChangesState
  store: ChangesStore
  /** Write actions disabled (read-only repo, operation in progress, pending writes). */
  writeDisabled?: boolean
  /** Every checkbox disabled (operation-state commit: the whole result is committed, A3 T9). */
  checksDisabled?: boolean
  /** Double-click / Enter on a row. */
  onOpenDiff: (path: string, scope: DiffOpenScope) => void
  /** "Commit this file…": the store already checked only this file; focus the message box. */
  onCommitFile?: (path: string) => void
  /** "Roll back this file…": the workbench opens the rollback sheet. */
  onRollback?: (paths: string[]) => void
  /** B3c "Shelve…": the workbench opens the shelve sheet. */
  onShelve?: (path: string, trigger: HTMLElement | null) => void
  /** "Add to VCS" for untracked files. */
  onAddToVcs?: (paths: string[]) => void
  onCopyPath?: (path: string) => void
  /** B2 entries: file history and worktree blame of one change. */
  onFileHistory?: (path: string) => void
  onBlame?: (path: string) => void
}

/** File rows in display order (skips collapsed subtrees); drives arrow-key navigation. */
export function visibleFiles(groups: readonly ChangeGroupView[]): ChangeTreeFile[] {
  const walk = (nodes: readonly ChangeTreeNode[]): ChangeTreeFile[] =>
    nodes.flatMap(node => (node.kind === 'file' ? [node] : walk(node.children)))
  return groups.flatMap(group => walk(group.nodes))
}

/** Next focus target for ArrowUp/ArrowDown/Home/End; null when the key is not navigation. */
export function nextFocus(rows: readonly ChangeTreeFile[], current: string | null, key: string): string | null {
  if (rows.length === 0) return null
  const index = rows.findIndex(row => row.entry.path === current)
  let target: number
  if (key === 'ArrowDown') target = index === -1 ? 0 : Math.min(index + 1, rows.length - 1)
  else if (key === 'ArrowUp') target = index === -1 ? 0 : Math.max(index - 1, 0)
  else if (key === 'Home') target = 0
  else if (key === 'End') target = rows.length - 1
  else return null
  return rows[target]?.entry.path ?? null
}

/** Combined check state of the whole visible list (header checkbox). */
export function overallCheck(groups: readonly ChangeGroupView[]): CheckState {
  const states = groups.filter(group => group.checkable).map(group => group.check)
  if (states.length === 0 || states.every(state => state === 'none')) return 'none'
  return states.every(state => state === 'all') ? 'all' : 'some'
}

function statText(entry: ChangeEntry): string | null {
  if (entry.group === 'untracked') return null
  if (entry.additions === undefined && entry.deletions === undefined) return null
  return `+${entry.additions ?? 0} −${entry.deletions ?? 0}`
}

interface TriCheckboxProps {
  state: CheckState
  disabled?: boolean
  label: string
  title?: string
  onToggle: () => void
}

/** Checkbox with a mixed state; a button so it renders the same without a DOM. */
export function TriCheckbox({ state, disabled = false, label, title, onToggle }: TriCheckboxProps): ReactNode {
  const ariaChecked = state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked}
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      tabIndex={-1}
      className={css.checkbox}
      data-check={state}
      onClick={(event) => {
        event.stopPropagation()
        if (!disabled) onToggle()
      }}
      onDoubleClick={event => event.stopPropagation()}
    />
  )
}

interface MenuState {
  entry: ChangeEntry
  x: number
  y: number
}

export interface ChangeContextMenuProps {
  entry: ChangeEntry
  writeDisabled: boolean
  onCommitFile?: (() => void) | undefined
  onRollback?: (() => void) | undefined
  onShelve?: (() => void) | undefined
  onAddToVcs?: (() => void) | undefined
  onCopyPath: () => void
  /** B2: open the file history / the worktree blame of this file. */
  onFileHistory?: (() => void) | undefined
  onBlame?: (() => void) | undefined
  onClose?: () => void
  /** Viewport coordinates; omitted in static rendering. */
  position?: { x: number; y: number }
}

/** Row context menu: commit this file, roll back, add to VCS (untracked only), copy path. */
export function ChangeContextMenu(props: ChangeContextMenuProps): ReactNode {
  const t = useT()
  const { entry, writeDisabled, onClose, position } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (onClose === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])
  const conflict = entry.group === 'conflicts'
  const style = position === undefined ? undefined : { left: `${position.x}px`, top: `${position.y}px` }
  const item = (label: string, action: (() => void) | undefined, disabled: boolean, name: string): ReactNode => (
    <button
      type="button"
      role="menuitem"
      className={css.menuItem}
      disabled={disabled || action === undefined}
      data-menu={name}
      onClick={action}
    >
      {label}
    </button>
  )
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('changes.menuLabel', { path: entry.path })}
      className={position === undefined ? css.menu : `${css.menu} ${css.menuFloating}`}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose?.()
        }
      }}
    >
      {conflict
        ? item(t('changes.menuResolveLater'), undefined, true, 'conflict')
        : item(t('changes.menuCommit'), props.onCommitFile, writeDisabled, 'commit')}
      {item(t('changes.menuRollback'), props.onRollback, writeDisabled || conflict, 'rollback')}
      {props.onShelve === undefined ? null : item(t('changes.menuShelve'), props.onShelve, writeDisabled || conflict, 'shelve')}
      {entry.group === 'untracked' ? item(t('changes.menuAddToVcs'), props.onAddToVcs, writeDisabled, 'add') : null}
      <div role="separator" className={css.menuSeparator} />
      {item(t('changes.menuCopyPath'), props.onCopyPath, false, 'copy')}
      {props.onFileHistory === undefined && props.onBlame === undefined ? null : (
        <>
          <div role="separator" className={css.menuSeparator} />
          {fileActions({ kind: 'change', status: entry.status }).map((action) => {
            const run = action.id === 'fileHistory' ? props.onFileHistory : props.onBlame
            const reason = action.disabledReason === undefined ? null : t(action.disabledReason.key)
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className={css.menuItem}
                disabled={reason !== null || run === undefined}
                data-menu={action.id}
                {...(reason === null ? {} : { title: reason })}
                onClick={run}
              >
                {t(action.label.key)}
                {reason === null ? null : <span className={css.menuReason}>{reason}</span>}
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}

interface RowHandlers {
  focused: string | null
  checksDisabled: boolean
  /** Row reachable with Tab: the focused one, else the first visible row. */
  tabStop: string | null
  onToggleFile: (path: string) => void
  onToggleNode: (key: string) => void
  onToggleCollapsed: (key: string) => void
  onFocus: (path: string) => void
  onOpen: (entry: ChangeEntry) => void
  onContextMenu: (entry: ChangeEntry, event: MouseEvent) => void
}

function FileRowView({ node, handlers }: { node: ChangeTreeFile; handlers: RowHandlers }): ReactNode {
  const t = useT()
  const { entry } = node
  const focused = handlers.focused === entry.path
  const stat = statText(entry)
  const title = entry.origPath === undefined ? entry.path : t('changes.renamedFrom', { from: entry.origPath, to: entry.path })
  return (
    <div
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={focused}
      aria-checked={node.disabled ? undefined : node.checked}
      tabIndex={handlers.tabStop === entry.path ? 0 : -1}
      className={[css.row, focused ? css.focused : '', node.disabled ? css.conflict : ''].filter(Boolean).join(' ')}
      style={{ '--git-tree-depth': node.depth } as CSSProperties}
      title={title}
      data-path={entry.path}
      data-group={entry.group}
      data-checked={node.checked}
      onClick={() => handlers.onFocus(entry.path)}
      onDoubleClick={() => handlers.onOpen(entry)}
      onContextMenu={event => handlers.onContextMenu(entry, event)}
    >
      <TriCheckbox
        state={node.checked ? 'all' : 'none'}
        disabled={node.disabled || handlers.checksDisabled}
        label={entry.path}
        {...(node.disabled ? { title: t('changes.conflictHint') } : {})}
        onToggle={() => handlers.onToggleFile(entry.path)}
      />
      <StatusLetter status={entry.status} />
      <span className={css.name}>{node.name}</span>
      {stat === null ? null : <span className={css.stat}>{stat}</span>}
    </div>
  )
}

function NodesView({ nodes, handlers }: { nodes: readonly ChangeTreeNode[]; handlers: RowHandlers }): ReactNode {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') return <FileRowView key={node.key} node={node} handlers={handlers} />
        return (
          <div key={node.key} role="group" className={css.group} data-dir={node.path}>
            <div
              className={css.dirRow}
              style={{ '--git-tree-depth': node.depth } as CSSProperties}
              aria-expanded={!node.collapsed}
              data-key={node.key}
              onClick={() => handlers.onToggleCollapsed(node.key)}
            >
              <span className={css.chevron} aria-hidden="true">{node.collapsed ? '▸' : '▾'}</span>
              <TriCheckbox
                state={node.check}
                disabled={!node.checkable || handlers.checksDisabled}
                label={node.path}
                onToggle={() => handlers.onToggleNode(node.key)}
              />
              <span className={css.name}>{node.name}</span>
              <span className={css.count}>{node.count}</span>
            </div>
            {node.collapsed ? null : <NodesView nodes={node.children} handlers={handlers} />}
          </div>
        )
      })}
    </>
  )
}

/**
 * The changes tree with its header (title, check-all, search).
 * @param props - store state, store actions and workbench callbacks.
 * @returns the tree section of the commit page.
 */
export function ChangesTree(props: ChangesTreeProps): ReactNode {
  const t = useT()
  const { state, store, writeDisabled = false, checksDisabled = false } = props
  const [menu, setMenu] = useState<MenuState | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(
    () => buildChangeGroups(state.entries, { checked: state.checked, search: state.search, collapsed: state.collapsed }),
    [state.entries, state.checked, state.search, state.collapsed],
  )
  const rows = useMemo(() => visibleFiles(groups), [groups])
  const checkedCount = state.checked.size
  const overall = overallCheck(groups)
  const copy = props.onCopyPath ?? copyText

  const open = (entry: ChangeEntry): void => {
    props.onOpenDiff(entry.path, entry.diffScope)
  }

  const handlers: RowHandlers = {
    focused: state.focused,
    checksDisabled,
    tabStop: rows.some(row => row.entry.path === state.focused) ? state.focused : (rows[0]?.entry.path ?? null),
    onToggleFile: path => store.toggleFile(path),
    onToggleNode: key => store.toggleNode(key),
    onToggleCollapsed: key => store.toggleCollapsed(key),
    onFocus: path => store.setFocused(path),
    onOpen: open,
    onContextMenu: (entry, event) => {
      event.preventDefault()
      store.setFocused(entry.path)
      setMenu({ entry, x: event.clientX, y: event.clientY })
    },
  }

  const focusRow = (path: string): void => {
    store.setFocused(path)
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(path) : path.replace(/"/g, '\\"')
    treeRef.current?.querySelector<HTMLElement>(`[data-path="${escaped}"]`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = nextFocus(rows, state.focused, event.key)
    if (target !== null) {
      event.preventDefault()
      focusRow(target)
      return
    }
    const current = rows.find(row => row.entry.path === state.focused)
    if (current === undefined) return
    if (event.key === 'Enter') {
      event.preventDefault()
      open(current.entry)
    } else if (event.key === ' ') {
      event.preventDefault()
      if (!current.disabled && !checksDisabled) store.toggleFile(current.entry.path)
    }
  }

  const query = state.search.trim()
  let body: ReactNode
  if (!state.loaded) body = <p className={css.message} aria-busy="true">{t('state.loading')}</p>
  else if (state.entries.length === 0) body = <p className={css.message}>{t('changes.empty')}</p>
  else if (groups.length === 0) body = <p className={css.message}>{t('changes.noMatch', { query })}</p>
  else {
    body = (
      <div ref={treeRef} role="tree" aria-label={t('changes.treeLabel')} aria-multiselectable="true" className={css.tree} onKeyDown={onKeyDown}>
        {groups.map(group => (
          <div key={group.key} role="group" className={css.group} data-change-group={group.kind}>
            <div
              className={css.groupRow}
              aria-expanded={!group.collapsed}
              data-key={group.key}
              onClick={() => store.toggleCollapsed(group.key)}
            >
              <span className={css.chevron} aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>
              <TriCheckbox
                state={group.check}
                disabled={!group.checkable || checksDisabled}
                label={t(group.label)}
                {...(group.checkable ? {} : { title: t('changes.conflictHint') })}
                onToggle={() => store.toggleNode(group.key)}
              />
              <span className={css.groupLabel}>{t(group.label)}</span>
              <span className={css.count}>{group.count}</span>
            </div>
            {group.collapsed ? null : <NodesView nodes={group.nodes} handlers={handlers} />}
          </div>
        ))}
      </div>
    )
  }

  return (
    <section className={css.root} data-changes-tree data-file-count={state.entries.length}>
      <div className={css.header}>
        <TriCheckbox
          state={overall}
          disabled={checksDisabled || !groups.some(group => group.checkable)}
          label={t('changes.checkAll')}
          title={t('changes.checkAll')}
          onToggle={() => store.checkAll(overall !== 'all')}
        />
        <span className={css.title}>{t('changes.title')}</span>
        <span className={css.count}>{state.entries.length}</span>
        {checkedCount > 0 ? <span className={css.checked}>{t('changes.checkedCount', { count: checkedCount })}</span> : null}
        <input
          type="search"
          className={css.search}
          placeholder={t('changes.searchPlaceholder')}
          aria-label={t('changes.searchLabel')}
          value={state.search}
          onChange={event => store.setSearch(event.target.value)}
        />
      </div>
      <div className={css.body}>{body}</div>
      {state.truncated ? <div className={css.footnote}>{t('changes.truncated', { count: state.entries.length })}</div> : null}
      {menu === null
        ? null
        : (
            <ChangeContextMenu
              entry={menu.entry}
              writeDisabled={writeDisabled}
              position={{ x: menu.x, y: menu.y }}
              onClose={() => setMenu(null)}
              onCommitFile={props.onCommitFile === undefined
                ? undefined
                : () => {
                    store.checkOnly(menu.entry.path)
                    props.onCommitFile?.(menu.entry.path)
                    setMenu(null)
                  }}
              onRollback={props.onRollback === undefined
                ? undefined
                : () => { props.onRollback?.([menu.entry.path]); setMenu(null) }}
              onAddToVcs={props.onAddToVcs === undefined
                ? undefined
                : () => { props.onAddToVcs?.([menu.entry.path]); setMenu(null) }}
              onShelve={props.onShelve === undefined
                ? undefined
                : () => {
                    const trigger = globalThis.document?.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null
                    props.onShelve?.(menu.entry.path, trigger)
                    setMenu(null)
                  }}
              onCopyPath={() => { copy(menu.entry.path); setMenu(null) }}
              onFileHistory={props.onFileHistory === undefined ? undefined : () => { props.onFileHistory?.(menu.entry.path); setMenu(null) }}
              onBlame={props.onBlame === undefined ? undefined : () => { props.onBlame?.(menu.entry.path); setMenu(null) }}
            />
          )}
    </section>
  )
}
