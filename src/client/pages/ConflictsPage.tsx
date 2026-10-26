// Conflict list overlay page (design §10.1–10.2, plan A3 T9 P0): unresolved / resolved groups,
// per-file "采用 <name>" for both sides (ours/theirs only in the tooltip), keep/delete for files one
// side deleted, mark resolved (second confirmation when markers remain), accept and finish
// (= merge commit / continue), resolve in terminal (copy a command) and close.
// B1 T7 (mergeWindow flag, `merge` props; absent = A3 markup): chunk counts per file, row selection,
// 「全部简单冲突」, the 「逐个解决 / 审查更改」 button (Review Changes queue) and the resolved row menu
// 「还原冲突解决」.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import type { ConflictCommandValue, ConflictResolution, MergeFileValue, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { OPERATION_KEY } from '../locales.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import {
  conflictGroups,
  conflictKindText,
  conflictRowActions,
  conflictSides,
  manualButton,
  nextSelection,
  reviewInputs,
  reviewQueue,
  useConflictReview,
  useConflictState,
  withStashLabel,
} from '../store/conflict-store.ts'
import type { ChunkCount, ConflictStore, ConflictStoreState, ReviewGroups, RowSelection } from '../store/conflict-store.ts'
import { Button } from '../ui/Button.tsx'
import { isContextMenuKey } from './commit-actions.ts'
import menuCss from './CommitContextMenu.module.css'
import { finishRowMenu, rowMenuAnchor } from './menu-focus.ts'
import { useFloatingMenu } from './menu-position.ts'
import type { MenuAnchor } from './menu-position.ts'
import { finishOperation, mergeMessageOf, resolveConflictFile, runSimpleAll, unresolveConflictFile } from './operation-actions.ts'
import { useInitialFocus } from './integrate-parts.tsx'
import integrateCss from './Integrate.module.css'
import css from './ConflictsPage.module.css'
import { PushOverlayFrame } from './PushRejectedPage.tsx'

/** Modifier keys of a row click: Cmd/Ctrl toggles, Shift selects a range. */
export interface SelectMods {
  toggle: boolean
  range: boolean
}

/** B1 T7 additions of the list (only passed when the mergeWindow flag is on). */
export interface ConflictMergeViewProps {
  /** Groups and effective reviewed set from `reviewInputs`. */
  groups: ReviewGroups
  reviewed: ReadonlySet<string>
  counts: ReadonlyMap<string, ChunkCount | null>
  selected: ReadonlySet<string>
  /** 「全部简单冲突」 is running. */
  simpleBusy: boolean
  /** Result of the last 「全部简单冲突」. */
  summary: LocalizedText | null
  /** Resolved row whose menu is open, where it opens, and the failure of its last restore. */
  menuPath: string | null
  menuAnchor?: MenuAnchor | undefined
  menuError: LocalizedText | null
  onSelect: (path: string, mods: SelectMods) => void
  onManual: (trigger: FocusTarget | null) => void
  onSimpleAll: (trigger: FocusTarget | null) => void
  onOpenMenu: (path: string, anchor: MenuAnchor, row: FocusTarget | null) => void
  onCloseMenu: () => void
  onUnresolve: (path: string) => void
}

/** Row clicks select, except on the row's own buttons. */
function rowClick(merge: ConflictMergeViewProps | undefined, path: string) {
  if (merge === undefined) return undefined
  return (event: MouseEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    merge.onSelect(path, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })
  }
}

function selectionMark(merge: ConflictMergeViewProps | undefined, path: string): { 'data-selected'?: 'true'; className: string } {
  const selected = merge?.selected.has(path) === true
  return selected ? { 'data-selected': 'true', className: `${css.row ?? ''} ${css.selected ?? ''}` } : { className: css.row ?? '' }
}

/** 「还原冲突解决」 menu of a resolved row (ADR 0006 menu material, menu-focus keyboard behaviour). */
function ResolvedRowMenu(props: { t: Translate; path: string; anchor?: MenuAnchor | undefined; disabledReason: string | null; onUnresolve: () => void; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { style, onKeyDown } = useFloatingMenu(ref, props.anchor, props.onClose)
  const reason = props.disabledReason
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={props.t('conflict.rowMenu', { path: props.path })}
      className={`${menuCss.menu ?? ''} ${props.anchor === undefined ? '' : (menuCss.floating ?? '')}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        className={`${menuCss.item ?? ''} ${reason === null ? '' : (menuCss.itemDisabled ?? '')}`}
        data-unresolve={props.path}
        {...(reason === null ? {} : { 'aria-disabled': true, title: reason })}
        onClick={() => { if (reason === null) props.onUnresolve() }}
      >
        <span>{props.t('conflict.unresolve')}</span>
        {reason === null ? null : <span className={menuCss.reason}>{reason}</span>}
      </button>
    </div>
  )
}

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
  /** B1 (mergeWindow flag): clicking an unresolved file name opens the merge window. */
  onOpenFile?: ((path: string, trigger: FocusTarget | null) => void) | undefined
  /** Footer 「中止…」 (carry 8): first click asks with the banner sentence. */
  abortConfirming?: boolean
  onAbortRequest?: (() => void) | undefined
  onAbortCancel?: (() => void) | undefined
  onAbort?: ((trigger: FocusTarget | null) => void) | undefined
  /** B1 T7: chunk counts, selection, 全部简单冲突, 逐个解决 / 审查更改 and the resolved row menu. */
  merge?: ConflictMergeViewProps | undefined
}

const triggerOf = (event: MouseEvent<HTMLElement>): FocusTarget => event.currentTarget

/** `已解决块/总块` of a counted file (nothing while loading, beyond the limit, or for binary files). */
function chunkCount(t: Translate, merge: ConflictMergeViewProps | undefined, path: string): ReactNode {
  const count = merge?.counts.get(path)
  if (count === undefined || count === null) return null
  return (
    <span className={css.chunks} title={t('conflict.chunks.title', { ...count })} data-chunk-count>
      {t('conflict.chunks', { ...count })}
    </span>
  )
}

export function ConflictsPageView(props: ConflictsPageViewProps): ReactNode {
  const { t, state, busyPath, markersPath, finishBusy, merge } = props
  const value = state.value
  const blockReason = props.blockReason ?? null
  const busy = finishBusy || busyPath !== null || merge?.simpleBusy === true
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
    const manual = merge === undefined ? null : manualButton(merge.groups, merge.selected, merge.reviewed)
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
                    <li
                      key={entry.path}
                      {...selectionMark(merge, entry.path)}
                      data-conflict-row={entry.path}
                      data-conflict-kind={entry.conflict ?? 'both-modified'}
                      onClick={rowClick(merge, entry.path)}
                    >
                      <span className={css.mark} aria-hidden="true">⚠</span>
                      {props.onOpenFile === undefined
                        ? <span className={css.path} title={entry.path}>{entry.path}</span>
                        : (
                            <button
                              type="button"
                              className={`${css.path ?? ''} ${css.pathButton ?? ''}`}
                              title={entry.path}
                              data-merge-open={entry.path}
                              onClick={(event) => { props.onOpenFile?.(entry.path, triggerOf(event)) }}
                            >
                              {entry.path}
                            </button>
                          )}
                      <span className={css.kind}>{t(kind.key, kind.params)}</span>
                      {chunkCount(t, merge, entry.path)}
                      <span className={css.buttons}>
                        {conflictRowActions(entry, shown).map(action => (
                          <Button
                            key={action.id}
                            tone={action.id === 'delete' ? 'danger' : 'ghost'}
                            disabled={rowBusy || finishBusy || merge?.simpleBusy === true || blockReason !== null}
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
                  {groups.resolved.map(path => merge === undefined
                    ? (
                        <li key={path} className={css.row} data-resolved-row={path}>
                          <span className={css.resolvedMark} aria-hidden="true">✓</span>
                          <span className={css.path} title={path}>{path}</span>
                        </li>
                      )
                    : (
                        <li
                          key={path}
                          {...selectionMark(merge, path)}
                          data-resolved-row={path}
                          tabIndex={0}
                          onClick={rowClick(merge, path)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            merge.onOpenMenu(path, { kind: 'point', x: event.clientX, y: event.clientY }, event.currentTarget)
                          }}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return
                            if (isContextMenuKey(event)) {
                              event.preventDefault()
                              merge.onOpenMenu(path, rowMenuAnchor(event.currentTarget), event.currentTarget)
                            } else if (event.key === ' ' || event.key === 'Enter') {
                              event.preventDefault()
                              merge.onSelect(path, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })
                            }
                          }}
                        >
                          <span className={css.resolvedMark} aria-hidden="true">✓</span>
                          <span className={css.path} title={path}>{path}</span>
                          {merge.groups.resolved.includes(path) && !merge.reviewed.has(path)
                            ? <span className={css.unreviewed} title={t('conflict.unreviewed.title')} data-unreviewed>{t('conflict.unreviewed')}</span>
                            : null}
                          {merge.menuPath === path
                            ? (
                                <ResolvedRowMenu
                                  t={t}
                                  path={path}
                                  anchor={merge.menuAnchor}
                                  disabledReason={blockReason}
                                  onUnresolve={() => { merge.onUnresolve(path) }}
                                  onClose={merge.onCloseMenu}
                                />
                              )
                            : null}
                          {merge.menuPath === path && merge.menuError !== null
                            ? <span className={css.rowError} role="alert">{t(merge.menuError.key, merge.menuError.params)}</span>
                            : null}
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
          {merge === undefined || merge.summary === null
            ? null
            : <span className={css.copied} role="status" data-simple-summary>{t(merge.summary.key, merge.summary.params)}</span>}
          {merge === undefined
            ? null
            : (
                <Button
                  disabled={unresolved === 0 || busy || blockReason !== null}
                  title={blockReason ?? t('conflict.simpleAll.title')}
                  aria-busy={merge.simpleBusy}
                  data-simple-all
                  onClick={(event) => { merge.onSimpleAll(triggerOf(event)) }}
                >
                  {t('conflict.simpleAll')}
                </Button>
              )}
          {manual === null
            ? (merge === undefined || stashPop ? null : <span className={css.copied} role="status" data-all-resolved>{t('conflict.allResolved')}</span>)
            : (
                <Button
                  tone="primary"
                  disabled={busy}
                  title={t('conflict.manual.title')}
                  data-manual={manual.label}
                  onClick={(event) => { merge?.onManual(triggerOf(event)) }}
                >
                  {t(manual.label === 'resolveManually' ? 'conflict.manual.resolveManually' : 'conflict.manual.reviewChanges')}
                </Button>
              )}
          {stashPop
            ? null
            : (
                <Button
                  tone={manual === null ? 'primary' : 'ghost'}
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
  /** B1: open the merge window for an unresolved file (only passed when the mergeWindow flag is on). */
  onOpenFile?: (path: string, trigger: FocusTarget | null) => void
  /** B1 T7 (mergeWindow flag): chunk counts, 全部简单冲突, Review Changes and 还原冲突解决. */
  merge?: ConflictsMergeDeps
  onClose: () => void
}

export interface ConflictsMergeDeps {
  loadFile: (path: string) => Promise<RpcResult<MergeFileValue>>
  /** 「逐个解决 / 审查更改」: open these files in the merge window one after another. */
  onReview: (queue: string[], trigger: FocusTarget | null) => void
}

interface RowMenu {
  path: string
  anchor: MenuAnchor
  row: FocusTarget | null
}

export function ConflictsPage({ store, actions, mergeMessage, blockReason, loadCommand, copy, onFinished, onAbort, onOpenFile, merge, onClose }: ConflictsPageProps): ReactNode {
  const t = useT()
  const state = useConflictState(store)
  const review = useConflictReview(store)
  const [selection, setSelection] = useState<RowSelection>({ selected: new Set(), anchor: null })
  const [simpleBusy, setSimpleBusy] = useState(false)
  const [summary, setSummary] = useState<LocalizedText | null>(null)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [menuError, setMenuError] = useState<LocalizedText | null>(null)
  const mergeOn = merge !== undefined
  // Chunk counts load lazily (one file at a time) whenever the list changes.
  useEffect(() => { if (mergeOn && state.value !== null) void store.loadCounts() }, [mergeOn, state.value, store])
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
          // Taking a whole side counts as reviewed (confirmation 2).
          if (mergeOn && (resolution === 'ours' || resolution === 'theirs')) store.markReviewed(path)
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

  const inputs = reviewInputs(state.value, review)
  const order = [...inputs.groups.unresolved, ...conflictGroups(state.value).resolved]
  const selected = new Set([...selection.selected].filter(path => order.includes(path)))

  const simpleAll = (trigger: FocusTarget | null): void => {
    const value = state.value
    if (merge === undefined || value === null || simpleBusy) return
    setSimpleBusy(true)
    setSummary(null)
    setError(null)
    void runSimpleAll({ actions, trigger, loadFile: merge.loadFile }, value.conflicts, store)
      .then((result) => { if (mounted.current) setSummary(result) })
      .finally(() => { if (mounted.current) setSimpleBusy(false) })
  }

  const closeMenu = (): void => {
    const row = menu?.row ?? null
    setMenu(null)
    setMenuError(null)
    finishRowMenu(row)
  }

  const unresolve = (path: string): void => {
    setMenuError(null)
    void unresolveConflictFile({ actions, trigger: menu?.row ?? null }, path).then((result) => {
      if (result.kind === 'done' || (result.kind === 'error' && result.stale === true)) {
        store.invalidateCount(path)
        void store.refresh()
      }
      if (!mounted.current) return
      if (result.kind === 'done') closeMenu()
      else if (result.kind === 'error') setMenuError(result.message)
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
      onOpenFile={onOpenFile}
      abortConfirming={abortConfirming}
      onAbortRequest={onAbort === undefined ? undefined : () => { setAbortConfirming(true) }}
      onAbortCancel={() => { setAbortConfirming(false) }}
      onAbort={onAbort === undefined
        ? undefined
        : (trigger) => {
            setAbortConfirming(false)
            onAbort(trigger)
          }}
      merge={merge === undefined
        ? undefined
        : {
            groups: inputs.groups,
            reviewed: inputs.reviewed,
            counts: review.counts,
            selected,
            simpleBusy,
            summary,
            menuPath: menu?.path ?? null,
            menuAnchor: menu?.anchor,
            menuError,
            onSelect: (path, mods) => { setSelection(current => nextSelection(order, current, path, mods)) },
            onManual: (trigger) => {
              const queue = reviewQueue(inputs.groups, selected, inputs.reviewed)
              if (queue.length > 0) merge.onReview(queue, trigger)
            },
            onSimpleAll: simpleAll,
            onOpenMenu: (path, anchor, row) => {
              setMenuError(null)
              setMenu({ path, anchor, row })
            },
            onCloseMenu: closeMenu,
            onUnresolve: unresolve,
          }}
    />
  )
}
