// B3d pages (design §11 Remotes, §6.2 Worktree, plan b3d T5): the remotes list with add / change URL /
// rename / remove (URLs only ever shown redacted), and the worktree list with add / remove / prune /
// copy path. Views are hook-free; containers load the lists and go through the action store.
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RemoteEntry, RemoteListValue, RpcResult, WorktreeEntry, WorktreeListValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { render } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import css from './RemotesPages.module.css'

type Actions = Pick<ActionStore, 'run'>

function failureOf(outcome: ActionOutcome<unknown>): LocalizedText | null {
  return outcome.kind === 'failed' ? outcome.message : outcome.kind === 'conflict' ? actionErrorText(outcome.error) : null
}

/** An edit the remotes page is collecting. */
export type RemoteEdit =
  | { kind: 'add'; name: string; url: string }
  | { kind: 'setUrl'; name: string; url: string }
  | { kind: 'rename'; name: string; newName: string }
  | { kind: 'remove'; name: string }

export interface RemotesPageViewProps {
  t: Translate
  remotes: RemoteEntry[] | null
  loadError: string | null
  edit: RemoteEdit | null
  busy: boolean
  error: LocalizedText | null
  onEdit: (edit: RemoteEdit | null) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onBack: () => void
}

function EditRow({ t, edit, busy, onEdit, onSubmit }: { t: Translate; edit: RemoteEdit; busy: boolean; onEdit: (edit: RemoteEdit | null) => void; onSubmit: (trigger: FocusTarget | null) => void }): ReactNode {
  const canSubmit = !busy && (
    edit.kind === 'add' ? edit.name.trim() !== '' && edit.url.trim() !== ''
      : edit.kind === 'setUrl' ? edit.url.trim() !== ''
        : edit.kind === 'rename' ? edit.newName.trim() !== '' && edit.newName !== edit.name
          : true)
  return (
    <form className={css.edit} onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit(event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')) }} data-remote-edit={edit.kind}>
      {edit.kind === 'add' ? <input aria-label={t('remotes.name')} placeholder={t('remotes.name')} value={edit.name} onChange={event => onEdit({ ...edit, name: event.target.value })} /> : null}
      {edit.kind === 'add' || edit.kind === 'setUrl'
        ? <input className={css.grow} aria-label={t('remotes.url')} placeholder={t(edit.kind === 'setUrl' ? 'remotes.url.new' : 'remotes.url')} value={edit.url} onChange={event => onEdit({ ...edit, url: event.target.value })} />
        : null}
      {edit.kind === 'rename' ? <input className={css.grow} aria-label={t('remotes.newName')} value={edit.newName} onChange={event => onEdit({ ...edit, newName: event.target.value })} /> : null}
      {edit.kind === 'remove' ? <span className={css.warning}>{t('remotes.remove.confirm', { name: edit.name })}</span> : null}
      <Button onClick={() => onEdit(null)}>{t('action.cancel')}</Button>
      <Button type="submit" tone={edit.kind === 'remove' ? 'danger' : 'primary'} disabled={!canSubmit}>{t(`remotes.submit.${edit.kind}`)}</Button>
    </form>
  )
}

export function RemotesPageView(props: RemotesPageViewProps): ReactNode {
  const { t, remotes, edit } = props
  return (
    <div className={css.root} role="dialog" aria-label={t('remotes.title')} tabIndex={-1} data-remotes-page>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('remotes.title')}</span>
        <Button tone="primary" disabled={props.busy} onClick={() => props.onEdit({ kind: 'add', name: '', url: '' })}>{t('remotes.add')}</Button>
      </div>
      {edit?.kind === 'add' ? <EditRow t={t} edit={edit} busy={props.busy} onEdit={props.onEdit} onSubmit={props.onSubmit} /> : null}
      {props.error === null ? null : <p className={css.error} role="alert">{render(t, props.error)}</p>}
      {props.loadError !== null ? <div className={css.state}><EmptyState error title={t('remotes.loadFailed')} hint={props.loadError} /></div> : null}
      {remotes === null && props.loadError === null ? <p className={css.state} role="status">{t('remotes.loading')}</p> : null}
      {remotes !== null && remotes.length === 0 ? <div className={css.state}><EmptyState title={t('remotes.none')} /></div> : null}
      <ul className={css.list}>
        {(remotes ?? []).map(remote => (
          <li key={remote.name} className={css.row} data-remote={remote.name}>
            <div className={css.line}>
              <strong>{remote.name}</strong>
              <span className={css.url} title={remote.fetchUrl}>{remote.fetchUrl}</span>
              <Button disabled={props.busy} onClick={() => props.onEdit({ kind: 'setUrl', name: remote.name, url: '' })}>{t('remotes.setUrl')}</Button>
              <Button disabled={props.busy} onClick={() => props.onEdit({ kind: 'rename', name: remote.name, newName: remote.name })}>{t('remotes.rename')}</Button>
              <Button tone="danger" disabled={props.busy} onClick={() => props.onEdit({ kind: 'remove', name: remote.name })}>{t('remotes.remove')}</Button>
            </div>
            {remote.pushUrl !== '' && remote.pushUrl !== remote.fetchUrl ? <div className={css.muted}>{t('remotes.pushUrl', { url: remote.pushUrl })}</div> : null}
            {edit !== null && edit.kind !== 'add' && edit.name === remote.name ? <EditRow t={t} edit={edit} busy={props.busy} onEdit={props.onEdit} onSubmit={props.onSubmit} /> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RemotesPage(props: { load: () => Promise<RpcResult<RemoteListValue>>; actions: Actions; onBack: () => void; onChanged: () => void }): ReactNode {
  const t = useT()
  const [remotes, setRemotes] = useState<RemoteEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [edit, setEdit] = useState<RemoteEdit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const loadRef = useRef(props.load)
  loadRef.current = props.load
  useEffect(() => {
    void loadRef.current().then((result) => {
      if (result.ok) setRemotes(result.value.remotes)
      else setLoadError(result.error.message)
    })
  }, [])
  const submit = async (trigger: FocusTarget | null): Promise<void> => {
    if (edit === null) return
    setBusy(true)
    setError(null)
    const payload = edit.kind === 'add' ? { action: 'add' as const, name: edit.name.trim(), url: edit.url.trim() }
      : edit.kind === 'setUrl' ? { action: 'setUrl' as const, name: edit.name, url: edit.url.trim() }
        : edit.kind === 'rename' ? { action: 'rename' as const, name: edit.name, newName: edit.newName.trim() }
          : { action: 'remove' as const, name: edit.name }
    const outcome = await props.actions.run('remoteEdit', payload, { target: `remote:${edit.name}`, trigger })
    setBusy(false)
    if (outcome.kind === 'done') {
      setRemotes(outcome.value.remotes)
      setEdit(null)
      props.onChanged()
    } else {
      setError(failureOf(outcome))
    }
  }
  return <RemotesPageView t={t} remotes={remotes} loadError={loadError} edit={edit} busy={busy} error={error} onEdit={(next) => { setEdit(next); setError(null) }} onSubmit={(trigger) => { void submit(trigger) }} onBack={props.onBack} />
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface WorktreesPageViewProps {
  t: Translate
  worktrees: WorktreeEntry[] | null
  loadError: string | null
  removing: { path: string; force: boolean } | null
  busy: boolean
  error: LocalizedText | null
  message: LocalizedText | null
  onAdd: (trigger: FocusTarget | null) => void
  onPrune: () => void
  onCopy: (path: string) => void
  onAskRemove: (removing: { path: string; force: boolean } | null) => void
  onRemove: () => void
  onBack: () => void
}

/**
 * Why a worktree cannot be removed (null: it can). The button stays focusable with `aria-disabled`
 * and the reason as its description, like the B4b menu items (T1, b3d review M4).
 */
function removeBlock(entry: WorktreeEntry): GitWorkbenchKey | null {
  if (entry.main || entry.bare) return 'worktrees.remove.main'
  if (entry.current) return 'worktrees.remove.current'
  if (entry.locked) return 'worktrees.remove.locked'
  return null
}

export function WorktreesPageView(props: WorktreesPageViewProps): ReactNode {
  const { t, worktrees } = props
  const reasonIdPrefix = `worktree-remove-reason${useId()}`
  const prunable = (worktrees ?? []).some(entry => entry.prunable)
  return (
    <div className={css.root} role="dialog" aria-label={t('worktrees.title')} tabIndex={-1} data-worktrees-page>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('worktrees.title')}</span>
        <Button disabled={props.busy || !prunable} title={prunable ? undefined : t('worktrees.prune.none')} onClick={props.onPrune}>{t('worktrees.prune')}</Button>
        <Button tone="primary" disabled={props.busy} onClick={(event) => props.onAdd(event.currentTarget)}>{t('worktrees.add')}</Button>
      </div>
      <p className={css.muted}>{t('worktrees.hint')}</p>
      {props.message === null ? null : <p className={css.message} role="status">{render(t, props.message)}</p>}
      {props.error === null ? null : <p className={css.error} role="alert">{render(t, props.error)}</p>}
      {props.loadError !== null ? <div className={css.state}><EmptyState error title={t('worktrees.loadFailed')} hint={props.loadError} /></div> : null}
      {worktrees === null && props.loadError === null ? <p className={css.state} role="status">{t('worktrees.loading')}</p> : null}
      <ul className={css.list}>
        {(worktrees ?? []).map((entry, index) => {
          const reason = removeBlock(entry)
          const reasonId = `${reasonIdPrefix}-${index}`
          return (
          <li key={entry.path} className={css.row} data-worktree={entry.path}>
            <div className={css.line}>
              <strong>{entry.branch ?? t('worktrees.detached', { sha: (entry.head ?? '').slice(0, 7) })}</strong>
              {entry.current ? <span className={css.badge}>{t('worktrees.current')}</span> : null}
              {entry.locked ? <span className={css.badge}>{t('worktrees.locked')}</span> : null}
              {entry.prunable ? <span className={css.badge}>{t('worktrees.prunable')}</span> : null}
              <span className={css.url} title={entry.path}>{entry.path}</span>
              <Button onClick={() => props.onCopy(entry.path)}>{t('worktrees.copyPath')}</Button>
              <Button
                tone="danger"
                disabled={props.busy}
                {...(reason === null ? {} : { 'aria-disabled': true, 'aria-describedby': reasonId, title: t(reason) })}
                onClick={() => { if (reason === null) props.onAskRemove({ path: entry.path, force: false }) }}
              >
                {t('worktrees.remove')}
              </Button>
            </div>
            {reason === null ? null : <div id={reasonId} className={css.muted} data-worktree-remove-reason>{t(reason)}</div>}
            {props.removing?.path === entry.path
              ? (
                  <div className={css.edit} role="alert">
                    <span className={css.warning}>{t(props.removing.force ? 'worktrees.remove.force' : 'worktrees.remove.confirm', { path: entry.path })}</span>
                    <Button onClick={() => props.onAskRemove(null)}>{t('action.cancel')}</Button>
                    <Button tone="danger" disabled={props.busy} onClick={props.onRemove}>{t(props.removing.force ? 'worktrees.remove.forceSubmit' : 'worktrees.remove.submit')}</Button>
                  </div>
                )
              : null}
          </li>
          )
        })}
      </ul>
    </div>
  )
}

export function WorktreesPage(props: { load: () => Promise<RpcResult<WorktreeListValue>>; actions: Actions; version: number | undefined; onAdd: (trigger: FocusTarget | null) => void; onBack: () => void; onCopy?: (text: string) => void }): ReactNode {
  const t = useT()
  const [worktrees, setWorktrees] = useState<WorktreeEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<{ path: string; force: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const [message, setMessage] = useState<LocalizedText | null>(null)
  const loadRef = useRef(props.load)
  loadRef.current = props.load
  const reload = (): void => {
    void loadRef.current().then((result) => {
      if (result.ok) { setWorktrees(result.value.worktrees); setLoadError(null) } else setLoadError(result.error.message)
    })
  }
  useEffect(reload, [props.version])
  const remove = async (): Promise<void> => {
    if (removing === null) return
    setBusy(true)
    setError(null)
    const outcome = await props.actions.run('worktreeRemove', { path: removing.path, force: removing.force }, { target: `worktree:${removing.path}`, trigger: null })
    setBusy(false)
    if (outcome.kind === 'done') {
      setRemoving(null)
      reload()
      return
    }
    if (outcome.kind === 'failed' && outcome.error.details?.['reason'] === 'worktree-dirty') {
      setRemoving({ path: removing.path, force: true })
      return
    }
    setError(failureOf(outcome))
  }
  const prune = async (): Promise<void> => {
    setBusy(true)
    const outcome = await props.actions.run('worktreePrune', {}, { target: 'worktree-prune', trigger: null })
    setBusy(false)
    if (outcome.kind === 'done') {
      setMessage({ key: 'worktrees.pruned', params: { count: outcome.value.pruned } })
      reload()
    } else {
      setError(failureOf(outcome))
    }
  }
  const copy = props.onCopy ?? ((text: string) => { void globalThis.navigator?.clipboard?.writeText(text) })
  return (
    <WorktreesPageView
      t={t} worktrees={worktrees} loadError={loadError} removing={removing} busy={busy} error={error} message={message}
      onAdd={props.onAdd} onPrune={() => { void prune() }} onCopy={copy}
      onAskRemove={(next) => { setRemoving(next); setError(null) }} onRemove={() => { void remove() }} onBack={props.onBack}
    />
  )
}
