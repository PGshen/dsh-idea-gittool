// Commit page grouped by changelist (design §8.2.2 P1, §14.3, plan b3c T5): one section per list with
// a tri-state check over its files, collapse, active mark, rename / delete / set active, drag rows onto
// a header to move them, and a row menu "move to …". The view is hook-free; the container keeps the
// small UI state (collapsed, editing, menu).
import { useEffect, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { ChangelistSection, ChangelistState } from '../changelists/changelist-model.ts'
import { DEFAULT_LIST, changelistSections } from '../changelists/changelist-model.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { ChangeEntry } from '../store/changes-store.ts'
import { matchesSearch } from '../store/changes-store.ts'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import css from './ChangelistView.module.css'

/** Drag payload type for moving changed files between lists. */
const DRAG_TYPE = 'application/x-dsh-git-paths'

export interface ChangelistViewProps {
  t: Translate
  sections: ChangelistSection<ChangeEntry>[]
  checked: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  editing: { id: string | null; value: string } | null
  menu: { path: string; x: number; y: number } | null
  writeDisabled: boolean
  onToggleCollapsed: (id: string) => void
  onToggleFile: (path: string) => void
  onSetChecked: (paths: string[], checked: boolean) => void
  onOpenDiff: (entry: ChangeEntry) => void
  onMove: (paths: string[], id: string) => void
  onSetActive: (id: string) => void
  onEdit: (editing: { id: string | null; value: string } | null) => void
  onCommitEdit: () => void
  onRemove: (id: string) => void
  onRowMenu: (menu: { path: string; x: number; y: number } | null) => void
}

export function listName(t: Translate, section: { list: { id: string; name: string } }): string {
  return section.list.id === DEFAULT_LIST ? t('changelist.default') : section.list.name
}

function EditBox({ t, value, onEdit, onCommit, id }: { t: Translate; value: string; id: string | null; onEdit: ChangelistViewProps['onEdit']; onCommit: () => void }): ReactNode {
  return (
    <input
      className={css.edit}
      value={value}
      aria-label={t(id === null ? 'changelist.new' : 'changelist.rename')}
      data-changelist-edit
      onChange={(event) => { onEdit({ id, value: event.target.value }) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); onCommit() }
        if (event.key === 'Escape') { event.stopPropagation(); onEdit(null) }
      }}
      onBlur={onCommit}
    />
  )
}

export function ChangelistView(props: ChangelistViewProps): ReactNode {
  const { t } = props
  const dropOn = (event: DragEvent<HTMLElement>, id: string): void => {
    const raw = event.dataTransfer.getData(DRAG_TYPE)
    if (raw === '') return
    event.preventDefault()
    props.onMove(JSON.parse(raw) as string[], id)
  }
  return (
    <div className={css.root} data-changelists>
      {props.sections.map((section) => {
        const id = section.list.id
        const collapsed = props.collapsed.has(id)
        const editing = props.editing?.id === id
        return (
          <section key={id} className={css.section} data-changelist={id}>
            <div
              className={section.active ? `${css.header} ${css.active}` : css.header}
              onDragOver={(event) => { if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault() }}
              onDrop={(event) => { dropOn(event, id) }}
            >
              <button type="button" className={css.chevron} aria-expanded={!collapsed} aria-label={t('changelist.toggle')} onClick={() => { props.onToggleCollapsed(id) }}>{collapsed ? '▸' : '▾'}</button>
              <input
                type="checkbox"
                aria-label={t('changelist.checkAll', { name: listName(t, section) })}
                checked={section.check === 'all'}
                ref={(node) => { if (node !== null) node.indeterminate = section.check === 'some' }}
                disabled={!section.checkable || props.writeDisabled}
                onChange={() => { props.onSetChecked(section.entries.filter(entry => entry.group !== 'conflicts').map(entry => entry.path), section.check !== 'all') }}
              />
              {editing
                ? <EditBox t={t} value={props.editing?.value ?? ''} id={id} onEdit={props.onEdit} onCommit={props.onCommitEdit} />
                : <span className={css.name}>{listName(t, section)}</span>}
              <span className={css.count}>{section.entries.length}</span>
              {section.active ? <span className={css.badge}>{t('changelist.activeBadge')}</span> : null}
              <span className={css.spacer} />
              {section.active ? null : <button type="button" className={css.action} onClick={() => { props.onSetActive(id) }}>{t('changelist.setActive')}</button>}
              {id === DEFAULT_LIST ? null : (
                <>
                  <button type="button" className={css.action} onClick={() => { props.onEdit({ id, value: section.list.name }) }}>{t('changelist.rename')}</button>
                  <button type="button" className={css.action} onClick={() => { props.onRemove(id) }}>{t('changelist.remove')}</button>
                </>
              )}
            </div>
            {collapsed ? null : (
              <ul className={css.files}>
                {section.entries.length === 0 ? <li className={css.empty}>{t('changelist.empty')}</li> : null}
                {section.entries.map(entry => (
                  <li
                    key={entry.path}
                    className={css.file}
                    draggable
                    data-change={entry.path}
                    onDragStart={(event) => {
                      const paths = props.checked.has(entry.path) ? [...props.checked] : [entry.path]
                      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDoubleClick={() => { props.onOpenDiff(entry) }}
                    onContextMenu={(event) => { event.preventDefault(); props.onRowMenu({ path: entry.path, x: event.clientX, y: event.clientY }) }}
                  >
                    <input
                      type="checkbox"
                      aria-label={entry.path}
                      checked={props.checked.has(entry.path)}
                      disabled={entry.group === 'conflicts' || props.writeDisabled}
                      onChange={() => { props.onToggleFile(entry.path) }}
                    />
                    <StatusLetter status={entry.status} />
                    <span className={css.path} title={entry.path}>{entry.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {props.editing?.id === null
        ? <div className={css.newRow}><EditBox t={t} value={props.editing.value} id={null} onEdit={props.onEdit} onCommit={props.onCommitEdit} /></div>
        : <button type="button" className={css.newButton} data-changelist-new onClick={() => { props.onEdit({ id: null, value: '' }) }}>{t('changelist.new')}</button>}
      {props.menu === null ? null : (
        <div role="menu" className={css.menu} style={{ left: `${String(props.menu.x)}px`, top: `${String(props.menu.y)}px` }} aria-label={t('changelist.moveTo')}>
          <div className={css.menuTitle}>{t('changelist.moveTo')}</div>
          {props.sections.map(section => (
            <button
              key={section.list.id}
              type="button"
              role="menuitem"
              className={css.menuItem}
              data-move-to={section.list.id}
              onClick={() => {
                const path = props.menu?.path ?? ''
                props.onMove(props.checked.has(path) ? [...props.checked] : [path], section.list.id)
                props.onRowMenu(null)
              }}
            >
              {listName(t, section)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface ChangelistPanelProps {
  entries: readonly ChangeEntry[]
  search: string
  checked: ReadonlySet<string>
  state: ChangelistState
  writeDisabled: boolean
  onToggleFile: (path: string) => void
  onSetChecked: (paths: string[], checked: boolean) => void
  onOpenDiff: (entry: ChangeEntry) => void
  onMove: (paths: string[], id: string) => void
  onSetActive: (id: string) => void
  onAdd: (name: string) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}

export function ChangelistPanel(props: ChangelistPanelProps): ReactNode {
  const t = useT()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string | null; value: string } | null>(null)
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const visible = props.entries.filter(entry => matchesSearch(entry, props.search))
  useEffect(() => {
    if (menu === null) return undefined
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[role="menu"]') !== null) return
      setMenu(null)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [menu])
  return (
    <ChangelistView
      t={t}
      sections={changelistSections(visible, props.state, props.checked)}
      checked={props.checked}
      collapsed={collapsed}
      editing={editing}
      menu={menu}
      writeDisabled={props.writeDisabled}
      onToggleCollapsed={(id) => {
        setCollapsed((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }}
      onToggleFile={props.onToggleFile}
      onSetChecked={props.onSetChecked}
      onOpenDiff={props.onOpenDiff}
      onMove={props.onMove}
      onSetActive={props.onSetActive}
      onEdit={setEditing}
      onCommitEdit={() => {
        if (editing === null) return
        const name = editing.value.trim()
        if (name !== '') {
          if (editing.id === null) props.onAdd(name)
          else props.onRename(editing.id, name)
        }
        setEditing(null)
      }}
      onRemove={props.onRemove}
      onRowMenu={setMenu}
    />
  )
}
