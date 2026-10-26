// Rollback confirmation sheet (design §8.2.5, Level 2 overlay §5.3): lists the files and counts,
// tracked files lose their working-tree changes (staged content is kept), untracked files are
// only deleted after an explicit danger tick. Cancel sends nothing. After the RPC the sheet shows
// what was kept staged or skipped.
import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { RollbackValue } from '../../shared/protocol.ts'
import {
  createRollbackStore,
  rememberFocus,
  rollbackCounts,
  rollbackEscapeAction,
  rollbackSubmitBlock,
  useRollbackState,
} from '../store/push-store.ts'
import type { RollbackBlockReason, RollbackClient, RollbackOutcome, RollbackState, RollbackStore, RollbackTarget } from '../store/push-store.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { submitHandler, WriteErrorNotice } from './PushRejectedPage.tsx'
import css from './RollbackSheet.module.css'

/** Every visible string of this file (moved into locales by T7). */

/** Rows shown before collapsing into "还有 N 个文件". */
export const ROLLBACK_VISIBLE_ROWS = 50

function copyToClipboard(text: string): void {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

export function rollbackBlockText(t: Translate, reason: RollbackBlockReason | null, readOnlyReason: string | null): string | null {
  if (readOnlyReason !== null) return t('write.readOnly', { reason: readOnlyReason })
  if (reason === null || reason === 'busy') return null
  return t(`rollback.block.${reason}`)
}

/** Whether the result carries something the user must read before the sheet closes. */
export function rollbackResultNeedsAttention(value: RollbackValue): boolean {
  return value.keptStaged.length > 0 || value.skipped.length > 0
}

// ---------------------------------------------------------------------------
// View (no hooks)
// ---------------------------------------------------------------------------

function PathList({ t, paths, label }: { t: Translate; paths: readonly string[]; label: string }): ReactNode {
  const visible = paths.slice(0, ROLLBACK_VISIBLE_ROWS)
  return (
    <>
      <ul className={css.files} aria-label={label}>
        {visible.map(path => <li key={path} className={css.file} title={path}>{path}</li>)}
      </ul>
      {paths.length > visible.length ? <p className={css.muted}>{t('rollback.more', { count: paths.length - visible.length })}</p> : null}
    </>
  )
}

function RollbackResult({ t, value }: { t: Translate; value: RollbackValue }): ReactNode {
  return (
    <div className={css.result} role="status" data-rollback-result>
      <strong>{t('rollback.resultTitle')}</strong>
      {value.restored.length > 0 ? <p className={css.line}>{t('rollback.restored', { count: value.restored.length })}</p> : null}
      {value.deleted.length > 0 ? <p className={css.line}>{t('rollback.deleted', { count: value.deleted.length })}</p> : null}
      {value.keptStaged.length > 0 ? (
        <div data-kept-staged>
          <p className={css.notice}>{t('rollback.keptStaged', { count: value.keptStaged.length })}</p>
          <PathList t={t} paths={value.keptStaged} label={t('rollback.keptStaged', { count: value.keptStaged.length })} />
        </div>
      ) : null}
      {value.skipped.length > 0 ? (
        <div data-skipped>
          <p className={css.notice}>{t('rollback.skipped', { count: value.skipped.length })}</p>
          <PathList t={t} paths={value.skipped} label={t('rollback.skipped', { count: value.skipped.length })} />
        </div>
      ) : null}
    </div>
  )
}

export interface RollbackSheetViewProps {
  t: Translate
  targets: readonly RollbackTarget[]
  state: RollbackState
  readOnlyReason: string | null
  rootRef?: Ref<HTMLDivElement>
  onCancel: () => void
  onDeleteConfirmedChange: (confirmed: boolean) => void
  onSubmit: () => void
  onCopy: (text: string) => void
  onShowConsole?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function RollbackSheetView({
  t,
  targets,
  state,
  readOnlyReason,
  rootRef,
  onCancel,
  onDeleteConfirmedChange,
  onSubmit,
  onCopy,
  onShowConsole,
  onKeyDown,
}: RollbackSheetViewProps): ReactNode {
  const counts = rollbackCounts(targets)
  const block = rollbackSubmitBlock(targets, state)
  const disabled = readOnlyReason !== null || block !== null
  const blockText = rollbackBlockText(t, block, readOnlyReason)
  const result = state.result

  return (
    <div className={css.layer} data-rollback-sheet>
      <div className={css.scrim} aria-hidden="true" onClick={state.busy ? undefined : onCancel} />
      <div
        ref={rootRef}
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('rollback.dialogLabel', { count: counts.total })}
        aria-busy={state.busy ? true : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={css.header}>
          <strong>{t('rollback.title')}</strong>
          <span className={css.muted}>{t('rollback.summary', { count: counts.total })}</span>
        </header>
        {result !== null ? (
          <div className={css.body}>
            <RollbackResult t={t} value={result} />
            <footer className={css.footer}>
              <span />
              <span className={css.actions}>
                <Button tone="primary" onClick={onCancel} data-primary>{t('action.close')}</Button>
              </span>
            </footer>
          </div>
        ) : (
          <form className={css.body} onSubmit={submitHandler(() => { if (!disabled) onSubmit() })}>
            <ul className={css.files} aria-label={t('rollback.summary', { count: counts.total })}>
              {targets.slice(0, ROLLBACK_VISIBLE_ROWS).map(target => (
                <li key={target.path} className={css.file} title={target.path} data-untracked={target.untracked ? 'true' : undefined}>
                  <span className={css.path}>{target.path}</span>
                  {target.untracked ? <span className={css.tag}>{t('rollback.untrackedTag')}</span> : null}
                </li>
              ))}
            </ul>
            {targets.length > ROLLBACK_VISIBLE_ROWS
              ? <p className={css.muted}>{t('rollback.more', { count: targets.length - ROLLBACK_VISIBLE_ROWS })}</p>
              : null}
            {counts.tracked > 0
              ? <p className={css.impact} data-tracked-impact>{t('rollback.trackedImpact', { count: counts.tracked })}</p>
              : null}
            {counts.untracked > 0 ? (
              <div className={css.danger} data-untracked-confirm>
                <label className={css.check}>
                  <input
                    type="checkbox"
                    checked={state.deleteConfirmed}
                    disabled={state.busy}
                    onChange={event => onDeleteConfirmedChange(event.currentTarget.checked)}
                  />
                  <span>{t('rollback.deleteUntracked', { count: counts.untracked })}</span>
                </label>
                {state.deleteConfirmed ? null : <span className={css.muted}>{t('rollback.untrackedSkipHint')}</span>}
              </div>
            ) : null}
            {state.error === null ? null : <WriteErrorNotice t={t} error={state.error} onCopy={onCopy} onShowConsole={onShowConsole} />}
            <footer className={css.footer}>
              {blockText === null ? <span /> : <span className={css.blockReason} data-block-reason>{blockText}</span>}
              <span className={css.actions}>
                <Button disabled={state.busy} onClick={onCancel}>{t('action.cancel')}</Button>
                <Button type="submit" tone="danger" disabled={disabled} aria-busy={state.busy ? true : undefined} data-primary>
                  {state.busy ? t('rollback.submitting') : t('rollback.submit')}
                </Button>
              </span>
            </footer>
          </form>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface RollbackSheetProps {
  sessionId: string
  /** Files to roll back; `untracked` ones are deleted only after the danger tick. */
  targets: readonly RollbackTarget[]
  /** Subset of GitClient: `rollback`. */
  client: RollbackClient
  readOnlyReason?: string | null
  /** Leave the sheet (cancel, Esc, scrim, or "关闭" after the result). No side effects on cancel. */
  onClose: () => void
  /** The rollback ran (refresh status). The sheet stays open when something was kept/skipped. */
  onDone: (value: RollbackValue) => void
  onShowConsole?: () => void
  onCopy?: (text: string) => void
  newRequestId?: () => string
  /** Inject a prepared store (tests). */
  store?: RollbackStore
}

/** Side effects of a finished rollback: report, then close unless the result needs reading. */
/** @returns true when the sheet stays open on the result view (the caller re-focuses it). */
export function handleRollbackOutcome(outcome: RollbackOutcome, callbacks: Pick<RollbackSheetProps, 'onClose' | 'onDone'>): boolean {
  if (outcome.kind !== 'done') return false
  callbacks.onDone(outcome.value)
  if (!rollbackResultNeedsAttention(outcome.value)) {
    callbacks.onClose()
    return false
  }
  return true
}

export function handleRollbackEscape(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>,
  state: Pick<RollbackState, 'busy'>,
  close: () => void,
): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  if (rollbackEscapeAction(state) === 'close') close()
}

export function RollbackSheet(props: RollbackSheetProps): ReactNode {
  const t = useT()
  const propsRef = useRef(props)
  propsRef.current = props
  const store = useMemo(
    () => props.store ?? createRollbackStore({
      client: { rollback: (...args) => propsRef.current.client.rollback(...args) },
      sessionId: props.sessionId,
      targets: props.targets,
      ...(props.newRequestId === undefined ? {} : { newRequestId: props.newRequestId }),
    }),
    // The target list is fixed for the life of the sheet; reopen it for a new selection.
    [props.sessionId],
  )
  const state = useRollbackState(store)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const restoreFocus = rememberFocus()
    rootRef.current?.focus()
    return () => {
      mounted.current = false
      restoreFocus()
    }
  }, [])

  const close = (): void => { if (mounted.current) propsRef.current.onClose() }

  return (
    <RollbackSheetView
      t={t}
      targets={props.targets}
      state={state}
      readOnlyReason={props.readOnlyReason ?? null}
      rootRef={rootRef}
      onCancel={close}
      onDeleteConfirmedChange={confirmed => store.setDeleteConfirmed(confirmed)}
      onSubmit={() => {
        void store.submit().then(outcome => {
          const staysOpen = handleRollbackOutcome(outcome, { onDone: value => propsRef.current.onDone(value), onClose: close })
          // The submit button is gone on the result view; keep focus inside so Esc still closes.
          if (staysOpen && mounted.current) rootRef.current?.focus()
        })
      }}
      onCopy={props.onCopy ?? copyToClipboard}
      {...(props.onShowConsole === undefined ? {} : { onShowConsole: props.onShowConsole })}
      onKeyDown={event => handleRollbackEscape(event, store.getState(), close)}
    />
  )
}
