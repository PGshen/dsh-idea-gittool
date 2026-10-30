// Shelf (design §8.4.1 `Stash | Shelf`, plan b3c T3): the shelf list with a patch preview and
// apply / apply-and-keep / delete, and the "shelve…" sheet opened from the commit page. Views are
// hook-free for static rendering; containers own the store and go through the action store.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { ShelfApplyValue, ShelfEntry } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { render } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import { createShelfStore, useShelfState } from '../store/shelf-store.ts'
import type { ShelfState, ShelfStore } from '../store/shelf-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import sheetCss from './BranchSheets.module.css'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useInitialFocus } from './integrate-parts.tsx'
import { formatLogDate } from './LogRow.tsx'
import css from './ShelfPanel.module.css'

type Actions = Pick<ActionStore, 'run'>

/** Paths "shelve…" takes from a row: every checked file when the row is checked, else the row alone. */
export function shelvePaths(path: string, checked: ReadonlySet<string>): string[] {
  return checked.has(path) ? [...checked].sort() : [path]
}

/** Default entry name: `搁置于 MM-DD HH:mm`. */
export function defaultShelfName(t: Translate, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return t('shelf.defaultName', { time: `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}` })
}

function failureText(outcome: ActionOutcome<unknown>): LocalizedText | null {
  return outcome.kind === 'failed' ? outcome.message : outcome.kind === 'conflict' ? actionErrorText(outcome.error) : null
}

// ---------------------------------------------------------------------------
// Shelf list
// ---------------------------------------------------------------------------

export interface ShelfPanelViewProps {
  t: Translate
  state: ShelfState
  now: number
  busy: boolean
  /** Why writes are disabled (read-only, operation in progress); null when allowed. */
  blockReason: string | null
  /** The last apply was refused because it does not apply cleanly. */
  notClean: boolean
  confirmingDrop: boolean
  message?: LocalizedText | null
  onSelect: (id: string) => void
  onApply: (keep: boolean, trigger: FocusTarget | null) => void
  onApplyThreeWay: (trigger: FocusTarget | null) => void
  onAskDrop: () => void
  onCancelDrop: () => void
  onDrop: (trigger: FocusTarget | null) => void
  onRetry: () => void
}

function Row({ entry, selected, now, t, onSelect }: { entry: ShelfEntry; selected: boolean; now: number; t: Translate; onSelect: () => void }): ReactNode {
  return (
    <li
      role="option"
      aria-selected={selected}
      className={selected ? `${css.row} ${css.selected}` : css.row}
      data-shelf={entry.id}
      onClick={onSelect}
    >
      <span className={css.name} title={entry.name}>{entry.name.split('\n')[0]}</span>
      <span className={css.meta}>
        {t('shelf.meta', { branch: entry.branch ?? t('shelf.detached'), count: entry.files.length })}
        {' · '}
        {formatLogDate(entry.createdAt, now)}
      </span>
    </li>
  )
}

export function ShelfPanelView(props: ShelfPanelViewProps): ReactNode {
  const { t, state, busy } = props
  if (state.status === 'error') {
    return <div className={css.state}><EmptyState error title={t('shelf.loadFailed')} hint={state.error?.message ?? t('action.retryHint')} action={{ label: t('action.retry'), onClick: props.onRetry }} /></div>
  }
  if (state.status !== 'ready') return <p className={css.state} role="status">{t('shelf.loading')}</p>
  if (state.shelves.length === 0) return <div className={css.state}><EmptyState title={t('shelf.empty')} hint={t('shelf.empty.hint')} /></div>
  const selected = state.shelves.find(entry => entry.id === state.selectedId) ?? null
  const writeDisabled = busy || props.blockReason !== null
  return (
    <div className={css.root} data-shelf-panel>
      <ul className={css.list} role="listbox" aria-label={t('shelf.list')}>
        {state.shelves.map(entry => (
          <Row key={entry.id} entry={entry} selected={entry.id === state.selectedId} now={props.now} t={t} onSelect={() => { props.onSelect(entry.id) }} />
        ))}
      </ul>
      {selected === null ? null : (
        <div className={css.detail}>
          <div className={css.actions}>
            <span className={css.files}>{selected.files.map(file => `${file.status} ${file.path}`).join('  ')}</span>
            <Button tone="primary" disabled={writeDisabled} title={props.blockReason ?? t('shelf.apply.title')} onClick={(event) => { props.onApply(false, event.currentTarget) }}>{t('shelf.apply')}</Button>
            <Button disabled={writeDisabled} title={props.blockReason ?? t('shelf.applyKeep.title')} onClick={(event) => { props.onApply(true, event.currentTarget) }}>{t('shelf.applyKeep')}</Button>
            <Button tone="danger" disabled={writeDisabled || props.confirmingDrop} onClick={props.onAskDrop}>{t('shelf.drop')}</Button>
          </div>
          {props.confirmingDrop
            ? (
                <div className={css.confirm} role="alert">
                  <span>{t('shelf.drop.confirm', { name: selected.name.split('\n')[0] ?? '' })}</span>
                  <Button onClick={props.onCancelDrop}>{t('action.cancel')}</Button>
                  <Button tone="danger" disabled={busy} onClick={(event) => { props.onDrop(event.currentTarget) }}>{t('shelf.drop.submit')}</Button>
                </div>
              )
            : null}
          {props.notClean
            ? (
                <div className={css.confirm} role="alert">
                  <span>{t('shelf.notClean')}</span>
                  <Button disabled={writeDisabled} onClick={(event) => { props.onApplyThreeWay(event.currentTarget) }}>{t('shelf.threeWay')}</Button>
                </div>
              )
            : null}
          {props.message === undefined || props.message === null ? null : <p className={css.message} role="status">{render(t, props.message)}</p>}
          {state.patchError !== null
            ? <p className={css.error} role="alert">{render(t, actionErrorText(state.patchError))}</p>
            : <pre className={css.preview} data-shelf-preview>{state.patch ?? t('shelf.loading')}</pre>}
        </div>
      )}
    </div>
  )
}

export interface ShelfPanelProps {
  store: ShelfStore
  actions: Actions
  busy: boolean
  blockReason: string | null
  /** Repository version: a change reloads the list. */
  version: number | undefined
  /** A three-way apply left conflicts: the workbench opens the conflict list. */
  onConflicts: (trigger: FocusTarget | null) => void
  onApplied: () => void
}

export function ShelfPanel(props: ShelfPanelProps): ReactNode {
  const t = useT()
  const state = useShelfState(props.store)
  // Plan t2 T2: both bars belong to the entry they were raised for. A refresh can move the selection
  // to another entry (the old one vanished, or results arrived out of order); the bars then hide and
  // their buttons act on the recorded id, never on whatever is selected now.
  const [notCleanId, setNotCleanId] = useState<string | null>(null)
  const [confirmingDropId, setConfirmingDropId] = useState<string | null>(null)
  const [message, setMessage] = useState<LocalizedText | null>(null)
  const [running, setRunning] = useState(false)
  const { store } = props
  useEffect(() => { void store.refresh() }, [store, props.version])
  const id = state.selectedId
  useEffect(() => {
    setNotCleanId(null)
    setConfirmingDropId(null)
  }, [id])
  const apply = async (id: string | null, keep: boolean, threeWay: boolean, trigger: FocusTarget | null): Promise<void> => {
    if (id === null) return
    setRunning(true)
    setMessage(null)
    const outcome = await props.actions.run('shelfApply', { id, keep, threeWay }, { target: `shelf:${id}`, trigger })
    setRunning(false)
    if (outcome.kind === 'done') {
      setNotCleanId(null)
      const value: ShelfApplyValue = outcome.value
      setMessage({ key: value.conflicts.length > 0 ? 'shelf.applied.conflicts' : 'shelf.applied', params: { count: value.conflicts.length } })
      props.onApplied()
      if (value.conflicts.length > 0) props.onConflicts(trigger)
      void store.refresh()
      return
    }
    if (outcome.kind === 'conflict' || (outcome.kind === 'failed' && outcome.error.code === 'git/conflict')) {
      // Only raise the bar while the refused entry is still the one shown.
      if (store.getState().selectedId === id) setNotCleanId(id)
      return
    }
    setMessage(failureText(outcome))
  }
  const drop = async (id: string | null, trigger: FocusTarget | null): Promise<void> => {
    if (id === null) return
    setRunning(true)
    const outcome = await props.actions.run('shelfDrop', { id }, { target: `shelf:${id}`, trigger })
    setRunning(false)
    setConfirmingDropId(null)
    setMessage(outcome.kind === 'done' ? null : failureText(outcome))
    void store.refresh()
  }
  return (
    <ShelfPanelView
      t={t}
      state={state}
      now={Date.now()}
      busy={props.busy || running}
      blockReason={props.blockReason}
      notClean={notCleanId !== null && notCleanId === id}
      confirmingDrop={confirmingDropId !== null && confirmingDropId === id}
      message={message}
      onSelect={(next) => { setNotCleanId(null); setConfirmingDropId(null); setMessage(null); void store.select(next) }}
      onApply={(keep, trigger) => { void apply(id, keep, false, trigger) }}
      onApplyThreeWay={(trigger) => { if (notCleanId === id) void apply(notCleanId, true, true, trigger) }}
      onAskDrop={() => { setConfirmingDropId(id) }}
      onCancelDrop={() => { setConfirmingDropId(null) }}
      onDrop={(trigger) => { if (confirmingDropId === id) void drop(confirmingDropId, trigger) }}
      onRetry={() => { void store.refresh() }}
    />
  )
}

/** The workbench's shelf store for one session. */
export function useShelfStore(client: { shelfList: Parameters<typeof createShelfStore>[0]['list']; shelfPatch: Parameters<typeof createShelfStore>[0]['patch'] }, sessionId: string): ShelfStore {
  const clientRef = useRef(client)
  clientRef.current = client
  return useMemo(() => createShelfStore({
    sessionId,
    list: (request, signal) => clientRef.current.shelfList(request, signal),
    patch: (request, signal) => clientRef.current.shelfPatch(request, signal),
  }), [sessionId])
}

// ---------------------------------------------------------------------------
// Shelve sheet
// ---------------------------------------------------------------------------

export interface ShelveSheetViewProps {
  t: Translate
  name: string
  paths: readonly string[]
  busy: boolean
  error: LocalizedText | null
  onName: (name: string) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
  rootRef?: Ref<HTMLDivElement>
}

export function ShelveSheetView(props: ShelveSheetViewProps): ReactNode {
  const { t, busy } = props
  const canSubmit = props.name.trim() !== '' && props.paths.length > 0 && !busy
  return (
    <SheetFrame
      dataKind="shelve"
      title={t('shelf.shelve.title')}
      label={t('shelf.shelve.title')}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <label className={sheetCss.field}>
          <span>{t('shelf.shelve.name')}</span>
          <input value={props.name} disabled={busy} data-autofocus="" data-shelf-name onChange={event => props.onName(event.target.value)} />
        </label>
        <p className={sheetCss.hint}>{t('shelf.shelve.files', { count: props.paths.length })}</p>
        <ul className={sheetCss.files}>{props.paths.map(path => <li key={path} className={sheetCss.file} title={path}>{path}</li>)}</ul>
        <p className={sheetCss.muted}>{t('shelf.shelve.explain')}</p>
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t('shelf.shelve.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function ShelveSheet(props: { paths: readonly string[]; actions: Actions; onShelved: () => void; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const [name, setName] = useState(() => defaultShelfName(t, new Date()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const submit = async (trigger: FocusTarget | null): Promise<void> => {
    setBusy(true)
    setError(null)
    const outcome = await props.actions.run('shelfCreate', { name: name.trim(), paths: [...props.paths] }, { target: 'shelf-create', trigger })
    setBusy(false)
    if (outcome.kind === 'done') {
      props.onShelved()
      props.onClose()
    } else {
      setError(failureText(outcome))
    }
  }
  return (
    <ShelveSheetView
      t={t}
      name={name}
      paths={props.paths}
      busy={busy}
      error={error}
      rootRef={rootRef}
      onName={setName}
      onSubmit={(trigger) => { void submit(trigger) }}
      onCancel={props.onClose}
    />
  )
}
