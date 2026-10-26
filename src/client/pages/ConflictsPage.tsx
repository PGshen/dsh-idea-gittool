// Conflict list overlay page (design §10.1–10.2, plan A3 T9 P0): unresolved / resolved groups,
// per-file "采用 <name>" for both sides (ours/theirs only in the tooltip), keep/delete for files one
// side deleted, mark resolved (second confirmation when markers remain), accept and finish
// (= merge commit / continue), resolve in terminal (copy a command) and close.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import type { ConflictCommandValue, ConflictResolution, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { OPERATION_KEY } from '../locales.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { conflictGroups, conflictKindText, conflictRowActions, conflictSides, useConflictState, withStashLabel } from '../store/conflict-store.ts'
import type { ConflictStore, ConflictStoreState } from '../store/conflict-store.ts'
import { Button } from '../ui/Button.tsx'
import { finishOperation, mergeMessageOf, resolveConflictFile } from './operation-actions.ts'
import { useInitialFocus } from './integrate-parts.tsx'
import integrateCss from './Integrate.module.css'
import css from './ConflictsPage.module.css'
import { PushOverlayFrame } from './PushRejectedPage.tsx'

export interface ConflictsPageViewProps {
  t: Translate
  state: ConflictStoreState
  /** Path whose resolution is running (its buttons wait). */
  busyPath: string | null
  /** mark-resolved found conflict markers in this path: ask before forcing. */
  markersPath: string | null
  error: LocalizedText | null
  copied: boolean
  finishBusy: boolean
  /** Why writes are disabled (read-only repository). */
  blockReason?: string | null
  rootRef?: Ref<HTMLDivElement>
  onResolve: (path: string, resolution: ConflictResolution, trigger: FocusTarget | null) => void
  onConfirmMarkers: (trigger: FocusTarget | null) => void
  onCancelMarkers: () => void
  onClose: () => void
  onFinish: (trigger: FocusTarget | null) => void
  onCopyCommand: (trigger: FocusTarget | null) => void
  onRetry: () => void
  /** Footer 「中止…」 (carry 8): first click asks with the banner sentence. */
  abortConfirming?: boolean
  onAbortRequest?: (() => void) | undefined
  onAbortCancel?: (() => void) | undefined
  onAbort?: ((trigger: FocusTarget | null) => void) | undefined
}

const triggerOf = (event: MouseEvent<HTMLElement>): FocusTarget => event.currentTarget

export function ConflictsPageView(props: ConflictsPageViewProps): ReactNode {
  const { t, state, busyPath, markersPath, finishBusy } = props
  const value = state.value
  const blockReason = props.blockReason ?? null
  const busy = finishBusy || busyPath !== null
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (markersPath !== null) props.onCancelMarkers()
    else if (props.abortConfirming === true) props.onAbortCancel?.()
    else if (!busy) props.onClose()
  }
  const operationName = value?.operation === null || value?.operation === undefined ? null : t(OPERATION_KEY[value.operation])
  const title = t('conflict.title')

  let body: ReactNode
  if (value === null) {
    body = state.status === 'error'
      ? (
          <p className={integrateCss.error} role="alert">
            {t('conflict.loadFailed', { code: state.error?.code ?? '' })}{' '}
            <Button data-conflict-retry onClick={props.onRetry}>{t('conflict.retry')}</Button>
          </p>
        )
      : <p className={integrateCss.hint} aria-busy="true">{t('state.loading')}</p>
  } else {
    // Carry 4: without an operation the conflicts come from restoring the stash.
    const stashPop = value.operation === null
    const shown = withStashLabel(value, t('conflict.stashLabel'))
    const sides = conflictSides(shown)
    const groups = conflictGroups(value)
    const unresolved = groups.unresolved.length
    const finishTitle = unresolved > 0
      ? t('conflict.finish.blocked', { count: unresolved })
      : value.operation === 'merge'
        ? t('conflict.finish.titleMerge')
        : t('conflict.finish.titleContinue', { operation: operationName ?? '' })
    body = (
      <>
        <p className={css.sides} data-conflict-sides>
          {t('conflict.sides', { ours: t(sides.ours.name.key, sides.ours.name.params), theirs: t(sides.theirs.name.key, sides.theirs.name.params) })}
        </p>
        {sides.note === null ? null : <p className={css.note} data-rebase-note>{t(sides.note.key, sides.note.params)}</p>}
        {stashPop ? <p className={css.note} data-stash-note>{t('conflict.stash.note')}</p> : null}
        <h3 className={css.groupTitle}>{t('conflict.unresolved', { count: unresolved })}</h3>
        {unresolved === 0
          ? <p className={integrateCss.hint}>{t('conflict.none')}</p>
          : (
              <ul className={css.group} aria-label={t('conflict.unresolved', { count: unresolved })}>
                {groups.unresolved.map((entry) => {
                  const rowBusy = busyPath === entry.path
                  const kind = conflictKindText(entry, shown)
                  return (
                    <li key={entry.path} className={css.row} data-conflict-row={entry.path} data-conflict-kind={entry.conflict ?? 'both-modified'}>
                      <span className={css.mark} aria-hidden="true">⚠</span>
                      <span className={css.path} title={entry.path}>{entry.path}</span>
                      <span className={css.kind}>{t(kind.key, kind.params)}</span>
                      <span className={css.buttons}>
                        {conflictRowActions(entry, shown).map(action => (
                          <Button
                            key={action.id}
                            tone={action.id === 'delete' ? 'danger' : 'ghost'}
                            disabled={rowBusy || finishBusy || blockReason !== null}
                            title={blockReason ?? t(action.title.key, action.title.params)}
                            data-resolution={action.resolution}
                            onClick={(event) => { props.onResolve(entry.path, action.resolution, triggerOf(event)) }}
                          >
                            {t(action.label.key, action.label.params)}
                          </Button>
                        ))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
        {groups.resolved.length === 0
          ? null
          : (
              <>
                <h3 className={css.groupTitle}>{t('conflict.resolved', { count: groups.resolved.length })}</h3>
                <ul className={css.group} aria-label={t('conflict.resolved', { count: groups.resolved.length })}>
                  {groups.resolved.map(path => (
                    <li key={path} className={css.row} data-resolved-row={path}>
                      <span className={css.resolvedMark} aria-hidden="true">✓</span>
                      <span className={css.path} title={path}>{path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
        {markersPath === null
          ? null
          : (
              <div className={css.confirm} role="alertdialog" aria-label={t('conflict.markers.title', { path: markersPath })} data-markers-confirm>
                <strong>{t('conflict.markers.title', { path: markersPath })}</strong>
                <span>{t('conflict.markers.body')}</span>
                <span className={css.confirmActions}>
                  <Button data-autofocus onClick={props.onCancelMarkers}>{t('action.cancel')}</Button>
                  <Button tone="danger" disabled={busyPath !== null} data-markers-force onClick={(event) => { props.onConfirmMarkers(triggerOf(event)) }}>
                    {t('conflict.markers.confirm')}
                  </Button>
                </span>
              </div>
            )}
        {props.error === null ? null : <p className={integrateCss.error} role="alert">{t(props.error.key, props.error.params)}</p>}
        {props.abortConfirming === true && !stashPop && operationName !== null
          ? (
              <div className={css.confirm} role="alert" data-abort-confirm>
                <span>{t('banner.abort.confirm', { operation: operationName })}</span>
                <span className={css.confirmActions}>
                  <Button data-autofocus onClick={props.onAbortCancel}>{t('banner.abort.cancel')}</Button>
                  <Button
                    tone="danger"
                    disabled={busy || blockReason !== null}
                    data-conflict-abort-confirm
                    data-danger
                    onClick={(event) => { props.onAbort?.(triggerOf(event)) }}
                  >
                    {t('banner.abort.confirmButton', { operation: operationName })}
                  </Button>
                </span>
              </div>
            )
          : null}
        <footer className={integrateCss.footer}>
          {unresolved > 0
            ? <p className={css.closeHint} data-close-hint>{t(stashPop ? 'conflict.stash.closeHint' : 'conflict.closeHint', { count: unresolved })}</p>
            : null}
          <Button onClick={props.onClose} disabled={finishBusy} data-conflict-close>{t('conflict.close')}</Button>
          <Button title={t('conflict.terminal.title')} data-conflict-terminal onClick={(event) => { props.onCopyCommand(triggerOf(event)) }}>
            {t('conflict.terminal')}
          </Button>
          {props.copied ? <span className={css.copied} role="status">{t('conflict.copied')}</span> : null}
          {stashPop || props.onAbortRequest === undefined
            ? null
            : (
                <Button
                  tone="danger"
                  disabled={busy || blockReason !== null || props.abortConfirming === true}
                  title={blockReason ?? undefined}
                  data-conflict-abort
                  data-danger
                  onClick={props.onAbortRequest}
                >
                  {t('banner.abort')}
                </Button>
              )}
          {stashPop
            ? null
            : (
                <Button
                  tone="primary"
                  disabled={unresolved > 0 || busy || blockReason !== null}
                  title={blockReason ?? finishTitle}
                  aria-busy={finishBusy}
                  data-conflict-finish
                  onClick={(event) => { props.onFinish(triggerOf(event)) }}
                >
                  {t('conflict.finish')}
                </Button>
              )}
        </footer>
      </>
    )
  }

  return (
    <PushOverlayFrame
      t={t}
      title={title}
      subtitle={operationName ?? undefined}
      label={title}
      busy={finishBusy}
      rootRef={props.rootRef}
      onBack={props.onClose}
      onKeyDown={onKeyDown}
    >
      <div className={integrateCss.body} data-conflicts-page>{body}</div>
    </PushOverlayFrame>
  )
}

export interface ConflictsPageProps {
  store: ConflictStore
  actions: Pick<ActionStore, 'run'>
  /** The merge message the user edited on the commit page ('' when untouched). */
  mergeMessage: string
  blockReason?: string | null
  loadCommand: () => Promise<RpcResult<ConflictCommandValue>>
  copy: (value: string) => void
  /** Accept and finish ended (the workbench maps it to notices / the log). */
  onFinished: (outcome: ActionOutcome<unknown>, step: 'commit' | 'continue') => void
  /** Confirmed 「中止…」 of the footer (the workbench runs `operationControl abort`). */
  onAbort?: (trigger: FocusTarget | null) => void
  onClose: () => void
}

export function ConflictsPage({ store, actions, mergeMessage, blockReason, loadCommand, copy, onFinished, onAbort, onClose }: ConflictsPageProps): ReactNode {
  const t = useT()
  const state = useConflictState(store)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [markersPath, setMarkersPath] = useState<string | null>(null)
  const [abortConfirming, setAbortConfirming] = useState(false)
  useInitialFocus(rootRef, `${markersPath ?? ''}|${String(abortConfirming)}`)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [finishBusy, setFinishBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resolve = (path: string, resolution: ConflictResolution, trigger: FocusTarget | null, force = false): void => {
    if (busyPath !== null) return
    setBusyPath(path)
    setError(null)
    void resolveConflictFile({ actions, trigger }, path, resolution, force).then((result) => {
      if (!mounted.current) return
      setBusyPath(null)
      switch (result.kind) {
        case 'done':
          setMarkersPath(null)
          void store.refresh()
          return
        case 'markers':
          setMarkersPath(result.path)
          return
        case 'error':
          setError(result.message)
          if (result.stale === true) void store.refresh()
          return
        case 'stay':
          return
      }
    })
  }

  const finish = (trigger: FocusTarget | null): void => {
    const value = state.value
    if (value === null || value.operation === null || finishBusy) return
    setFinishBusy(true)
    setError(null)
    const step = value.operation === 'merge' ? 'commit' : 'continue'
    void finishOperation({ actions, trigger }, value, mergeMessageOf(value, mergeMessage)).then((outcome) => {
      if (mounted.current) setFinishBusy(false)
      // A failure is shown in the list itself while it is open.
      if (outcome.kind === 'failed' && mounted.current) {
        setError(outcome.message)
        return
      }
      onFinished(outcome, step)
    })
  }

  const copyCommand = (): void => {
    setError(null)
    void loadCommand().then((result) => {
      if (!mounted.current) return
      if (result.ok) {
        copy(result.value.command)
        setCopied(true)
      } else {
        setError(text('conflict.loadFailed', { code: result.error.code }))
      }
    })
  }

  return (
    <ConflictsPageView
      t={t}
      state={state}
      busyPath={busyPath}
      markersPath={markersPath}
      error={error}
      copied={copied}
      finishBusy={finishBusy}
      blockReason={blockReason ?? null}
      rootRef={rootRef}
      onResolve={(path, resolution, trigger) => { resolve(path, resolution, trigger) }}
      onConfirmMarkers={(trigger) => { if (markersPath !== null) resolve(markersPath, 'mark-resolved', trigger, true) }}
      onCancelMarkers={() => { setMarkersPath(null) }}
      onClose={onClose}
      onFinish={finish}
      onCopyCommand={copyCommand}
      onRetry={() => { void store.refresh() }}
      abortConfirming={abortConfirming}
      onAbortRequest={onAbort === undefined ? undefined : () => { setAbortConfirming(true) }}
      onAbortCancel={() => { setAbortConfirming(false) }}
      onAbort={onAbort === undefined
        ? undefined
        : (trigger) => {
            setAbortConfirming(false)
            onAbort(trigger)
          }}
    />
  )
}
