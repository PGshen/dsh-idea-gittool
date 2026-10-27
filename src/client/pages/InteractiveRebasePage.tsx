// Interactive rebase overlay (design §11 "Interactive Rebase", plan b3a T5): a full-height list of the
// commits from the base to HEAD, oldest first. Each row picks an action; rows move by drag or Alt+↑/↓;
// a reword row or the head of a squash group edits its message below the list; the todo can be
// previewed exactly as the Host will run it. The view is static-renderable; the container owns the store.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import type { InteractiveRebaseValue, RebaseAction } from '../../shared/protocol.ts'
import { REBASE_ACTIONS, REBASE_PLAN_MAX_COMMITS } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../localized-text.ts'
import { MESSAGE_PLACEHOLDER, groupMessage, groups, move, previewTodo, setAction, setMessage } from '../rebase/rebase-model.ts'
import type { RebasePreset, RebaseRow } from '../rebase/rebase-model.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { createRebaseStore, useRebaseState } from '../store/rebase-store.ts'
import type { RebasePlanLoader, RebaseState } from '../store/rebase-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import css from './InteractiveRebasePage.module.css'
import { formatLogDate } from './LogRow.tsx'

/** Letter keys that switch the selected row's action (IntelliJ / git todo abbreviations). */
const ACTION_KEYS: Readonly<Record<string, RebaseAction>> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' }

export type RebaseKeyAction =
  | { kind: 'select'; delta: number }
  | { kind: 'move'; delta: number }
  | { kind: 'action'; action: RebaseAction }

/** What a key press on the list does; null for keys the list leaves alone (and inside form fields). */
export function rebaseKeyAction(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; inField: boolean }): RebaseKeyAction | null {
  if (event.inField || event.ctrlKey || event.metaKey) return null
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const delta = event.key === 'ArrowUp' ? -1 : 1
    return event.altKey ? { kind: 'move', delta } : { kind: 'select', delta }
  }
  if (event.altKey) return null
  const action = ACTION_KEYS[event.key.toLowerCase()]
  return action === undefined ? null : { kind: 'action', action }
}

/** The row whose message the editor shows: a reword row, or the head of a group with squash members. */
export function messageTarget(rows: readonly RebaseRow[], selected: number): { head: number; count: number } | null {
  for (const group of groups(rows)) {
    if (group.head !== selected && !group.members.includes(selected)) continue
    if (groupMessage(rows, group) === undefined) return null
    return { head: group.head, count: 1 + group.members.length }
  }
  return null
}

/** Row to select when the page opens: the preset's commit (a squash: the commit the others fold into). */
export function presetIndex(rows: readonly RebaseRow[], preset: RebasePreset | undefined): number {
  if (preset === undefined) return 0
  const shas = new Set(preset.kind === 'squash' ? preset.shas : [preset.sha])
  return Math.max(0, rows.findIndex(row => shas.has(row.sha)))
}

/** The todo as shown: message exec lines become a readable comment. */
export function displayTodo(todo: string, t: Translate): string {
  return todo
    .split('\n')
    .map(line => (line.includes(MESSAGE_PLACEHOLDER) ? t('rebase.preview.writeMessage') : line))
    .join('\n')
}

export interface InteractiveRebasePageViewProps {
  state: RebaseState
  selected: number
  showPreview: boolean
  failure: string | null
  now: number
  onBack: () => void
  onRetry: () => void
  onSelect: (index: number) => void
  onRows: (change: (rows: RebaseRow[]) => RebaseRow[]) => void
  onUpdateRefs: (on: boolean) => void
  onConfirmPushed: (on: boolean) => void
  onTogglePreview: () => void
  onSubmit: (trigger: FocusTarget | null) => void
}

export function InteractiveRebasePageView(props: InteractiveRebasePageViewProps): ReactNode {
  const t = useT()
  const { state } = props
  const branch = state.plan?.branch ?? ''
  return (
    <div className={css.root} role="dialog" aria-label={t('rebase.dialog', { branch })} tabIndex={-1} data-rebase>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('rebase.title')}</span>
      </div>
      {bodyOf(props, t)}
    </div>
  )
}

function bodyOf(props: InteractiveRebasePageViewProps, t: Translate): ReactNode {
  const { state } = props
  if (state.status === 'error') {
    return <div className={css.state}><EmptyState error title={t('rebase.loadFailed')} hint={state.error?.message ?? t('action.retryHint')} action={{ label: t('action.retry'), onClick: props.onRetry }} /></div>
  }
  const plan = state.plan
  if (plan === null) return <p className={css.state} role="status">{t('rebase.loading')}</p>
  if (plan.blocked !== undefined) {
    return (
      <div className={css.state} data-rebase-blocked={plan.blocked}>
        <p>{t(`rebase.blocked.${plan.blocked}`, { limit: REBASE_PLAN_MAX_COMMITS })}</p>
        {plan.blocked === 'empty' || plan.blocked === 'detached' ? null : (
          <>
            <p className={css.hint}>{t('rebase.blocked.hint')}</p>
            <code className={css.command}>{plan.base === null ? 'git rebase -i --root' : `git rebase -i ${plan.base}`}</code>
          </>
        )}
      </div>
    )
  }
  const count = plan.commits.length
  const base = plan.base === null ? null : plan.base.slice(0, 7)
  return (
    <>
      <div className={css.banner}>
        {base === null ? t('rebase.banner.root', { branch: plan.branch, count }) : t('rebase.banner', { branch: plan.branch, count, base })}
      </div>
      <RebaseList {...props} />
      {messageEditor(props, t)}
      {props.showPreview ? (
        <pre className={css.preview} aria-label={t('rebase.preview.title')} data-rebase-preview>
          {displayTodo(previewTodo(plan, state.rows, { updateRefs: state.updateRefs && plan.supportsUpdateRefs }), t)}
        </pre>
      ) : null}
      {footerOf(props, t)}
    </>
  )
}

function RebaseList(props: InteractiveRebasePageViewProps): ReactNode {
  const t = useT()
  const { state, selected } = props
  const dragFrom = useRef<number | null>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement
    const inField = target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
    const action = rebaseKeyAction({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, inField })
    if (action === null) return
    event.preventDefault()
    const last = state.rows.length - 1
    if (action.kind === 'select') props.onSelect(Math.max(0, Math.min(last, selected + action.delta)))
    else if (action.kind === 'move') {
      const to = Math.max(0, Math.min(last, selected + action.delta))
      if (to === selected) return
      props.onRows(rows => move(rows, selected, to))
      props.onSelect(to)
    } else props.onRows(rows => setAction(rows, selected, action.action))
  }
  const drop = (event: DragEvent<HTMLLIElement>, to: number): void => {
    event.preventDefault()
    const from = dragFrom.current
    dragFrom.current = null
    if (from === null || from === to) return
    props.onRows(rows => move(rows, from, to))
    props.onSelect(to)
  }
  return (
    <ul
      className={css.list}
      role="listbox"
      aria-label={t('rebase.list')}
      aria-activedescendant={state.rows[selected] === undefined ? undefined : `rebase-row-${String(selected)}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-rebase-list
    >
      {state.rows.map((row, index) => (
        <li
          key={row.sha}
          id={`rebase-row-${String(index)}`}
          role="option"
          aria-selected={index === selected}
          aria-label={t('rebase.row', { action: row.action, sha: row.shortSha, subject: row.subject })}
          className={[css.row, index === selected ? css.selected : '', row.action === 'drop' ? css.dropped : '', row.action === 'squash' || row.action === 'fixup' ? css.folded : ''].filter(Boolean).join(' ')}
          draggable
          onDragStart={() => { dragFrom.current = index }}
          onDragOver={(event) => { event.preventDefault() }}
          onDrop={(event) => { drop(event, index) }}
          onClick={() => { props.onSelect(index) }}
          data-rebase-row={row.sha}
          data-action={row.action}
        >
          <span className={css.handle} title={t('rebase.row.handle')} aria-hidden="true">⋮⋮</span>
          <select
            className={css.action}
            value={row.action}
            aria-label={t('rebase.row.action', { sha: row.shortSha })}
            onChange={(event) => { props.onRows(rows => setAction(rows, index, event.target.value as RebaseAction)) }}
            onFocus={() => { props.onSelect(index) }}
          >
            {REBASE_ACTIONS.map(action => <option key={action} value={action}>{t(`rebase.action.${action}`)}</option>)}
          </select>
          <code className={css.sha}>{row.shortSha}</code>
          <span className={css.subject}>{row.subject}</span>
          {row.branches.map(name => <span key={name} className={css.chip}>{name}</span>)}
          {row.pushed ? <span className={css.pushed} title={t('rebase.row.pushed.title')}>{t('rebase.row.pushed')}</span> : null}
          <span className={css.meta}>{row.author} · {formatLogDate(row.date, props.now)}</span>
        </li>
      ))}
    </ul>
  )
}

function messageEditor(props: InteractiveRebasePageViewProps, t: Translate): ReactNode {
  const { state } = props
  const target = messageTarget(state.rows, props.selected)
  if (target === null) return <p className={css.hint}>{t('rebase.keys')} · {t('rebase.message.hint')}</p>
  const head = state.rows[target.head]
  const group = groups(state.rows).find(candidate => candidate.head === target.head)
  const value = group === undefined ? head?.message ?? '' : groupMessage(state.rows, group) ?? ''
  const label = target.count > 1 ? t('rebase.message.group', { count: target.count }) : t('rebase.message.label', { sha: head?.shortSha ?? '' })
  return (
    <label className={css.message}>
      <span className={css.messageLabel}>{label}</span>
      <textarea
        className={css.textarea}
        value={value}
        rows={5}
        spellCheck={false}
        onChange={(event) => { props.onRows(rows => setMessage(rows, target.head, event.target.value)) }}
        data-rebase-message
      />
    </label>
  )
}

function footerOf(props: InteractiveRebasePageViewProps, t: Translate): ReactNode {
  const { state } = props
  const plan = state.plan
  return (
    <div className={css.footer}>
      {state.rewritesPushed ? (
        <div className={css.warning} role="alert">
          <p>{t('rebase.pushed.warning')}</p>
          <label className={css.check}>
            <input type="checkbox" checked={state.confirmPushed} onChange={(event) => { props.onConfirmPushed(event.target.checked) }} />
            {t('rebase.pushed.confirm')}
          </label>
        </div>
      ) : null}
      {plan?.supportsUpdateRefs === true ? (
        <label className={css.check}>
          <input type="checkbox" checked={state.updateRefs} onChange={(event) => { props.onUpdateRefs(event.target.checked) }} />
          {t('rebase.updateRefs')}
        </label>
      ) : null}
      {props.failure === null ? null : <p className={css.error} role="alert">{t('rebase.failed', { message: props.failure })}</p>}
      <div className={css.actions}>
        <Button onClick={props.onTogglePreview} aria-pressed={props.showPreview}>{props.showPreview ? t('rebase.preview.hide') : t('rebase.preview.show')}</Button>
        <span className={css.reason} data-rebase-invalid>{state.invalid === null ? '' : t(state.invalid.key, state.invalid.params)}</span>
        <Button
          tone="primary"
          disabled={state.invalid !== null || state.submitting}
          title={state.invalid === null ? undefined : t(state.invalid.key, state.invalid.params)}
          onClick={(event) => { props.onSubmit(event.currentTarget) }}
        >
          {state.submitting ? t('rebase.submitting') : t('rebase.submit')}
        </Button>
      </div>
    </div>
  )
}

/**
 * What the workbench does once a rebase ran: a conflict stop opens the conflict list (it is a normal
 * result here, not `git/conflict`); finishing or any other stop closes the page (the banner takes over).
 */
export function afterInteractiveRebase(
  result: Pick<InteractiveRebaseValue, 'stop'>,
  deps: { openConflicts: () => void; close: () => void; refresh: () => void },
): void {
  if (result.stop === 'conflict') deps.openConflicts()
  else deps.close()
  deps.refresh()
}

export interface InteractiveRebasePageProps {
  sessionId: string
  base: string | null
  preset?: RebasePreset | undefined
  load: RebasePlanLoader
  actions: Pick<ActionStore, 'run'>
  onBack: () => void
  /** The rebase ran (finished or stopped); the workbench closes the page and follows up. */
  onDone: (value: InteractiveRebaseValue, trigger: FocusTarget | null) => void
}

export function InteractiveRebasePage(props: InteractiveRebasePageProps): ReactNode {
  const t = useT()
  const loadRef = useRef(props.load)
  const actionsRef = useRef(props.actions)
  loadRef.current = props.load
  actionsRef.current = props.actions
  const store = useMemo(
    () => createRebaseStore({
      sessionId: props.sessionId,
      load: (request, signal) => loadRef.current(request, signal),
      actions: { run: (endpoint, payload, options) => actionsRef.current.run(endpoint, payload, options) },
    }),
    [props.sessionId],
  )
  const state = useRebaseState(store)
  const [selected, setSelected] = useState(0)
  const [showPreview, setShowPreview] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { base, preset } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { rootRef.current?.querySelector<HTMLElement>('[data-rebase]')?.focus() }, [])
  useEffect(() => {
    setSelected(0)
    void store.open(base, preset).then(() => {
      setSelected(presetIndex(store.getState().rows, preset))
      // L4: keys act on the list, so it takes focus once loaded; a reword goes straight to its message.
      requestAnimationFrame(() => {
        const root = rootRef.current
        const target = preset?.kind === 'reword'
          ? root?.querySelector<HTMLElement>('[data-rebase-message]')
          : root?.querySelector<HTMLElement>('[data-rebase-list]')
        target?.focus()
      })
    })
  }, [store, base, preset])
  useEffect(() => () => { store.close() }, [store])
  const submit = async (trigger: FocusTarget | null): Promise<void> => {
    setFailure(null)
    const outcome: ActionOutcome<InteractiveRebaseValue> | undefined = await store.submit(trigger)
    if (outcome?.kind === 'done') props.onDone(outcome.value, trigger)
    else if (outcome?.kind === 'failed') setFailure(t(outcome.message.key, outcome.message.params))
  }
  return (
    <div ref={rootRef}>
      <InteractiveRebasePageView
        state={state}
        selected={selected}
        showPreview={showPreview}
        failure={failure}
        now={Date.now()}
        onBack={props.onBack}
        onRetry={() => { void store.open(base, preset) }}
        onSelect={setSelected}
        onRows={(change) => { store.update(change) }}
        onUpdateRefs={(on) => { store.setUpdateRefs(on) }}
        onConfirmPushed={(on) => { store.setConfirmPushed(on) }}
        onTogglePreview={() => { setShowPreview(shown => !shown) }}
        onSubmit={(trigger) => { void submit(trigger) }}
      />
    </div>
  )
}
