// Smart checkout (design §8.3.3, plan A3 T7): opened only when git refused a checkout because it
// would overwrite local changes. Lists the files, then "stash and checkout" (restored afterwards),
// "force checkout" (discards the changes, needs a confirmation) or cancel. When only untracked
// files are in the way, stashing cannot help (it only takes tracked changes): no stash button.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { CheckoutMode, CheckoutTarget } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import css from './BranchSheets.module.css'

/** Paths listed before the total. */
export const SMART_VISIBLE_PATHS = 10

export type SmartCheckoutResult =
  | { kind: 'closed'; outcome: ActionOutcome<unknown> }
  | { kind: 'error'; message: LocalizedText }

/** Resend the checkout with the chosen mode; failures stay in the sheet. */
export async function submitSmartCheckout(
  actions: Pick<ActionStore, 'run'>,
  target: CheckoutTarget,
  mode: Exclude<CheckoutMode, 'normal'>,
  trigger: FocusTarget | null,
): Promise<SmartCheckoutResult> {
  const outcome = await actions.run('checkout', { target, mode }, { trigger })
  if (outcome.kind === 'failed') return { kind: 'error', message: outcome.message }
  return { kind: 'closed', outcome }
}

export interface SmartCheckoutSheetViewProps {
  t: Translate
  target: CheckoutTarget
  paths: string[]
  /** Untracked files git refuses to overwrite (`WouldOverwriteDetails.untracked`). */
  untracked: string[]
  forceConfirmed: boolean
  busy: boolean
  error: LocalizedText | null
  rootRef?: Ref<HTMLDivElement>
  onStash: (trigger: FocusTarget | null) => void
  onForce: (trigger: FocusTarget | null) => void
  onCancel: () => void
  onForceConfirmChange: (confirmed: boolean) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function SmartCheckoutSheetView(props: SmartCheckoutSheetViewProps): ReactNode {
  const { t, target, paths, untracked, busy, error } = props
  const visible = paths.slice(0, SMART_VISIBLE_PATHS)
  const more = paths.length - visible.length
  const visibleUntracked = untracked.slice(0, SMART_VISIBLE_PATHS)
  const moreUntracked = untracked.length - visibleUntracked.length
  // Stash only takes tracked changes: useless when nothing tracked is in the way.
  const canStash = paths.length > 0 || untracked.length === 0
  return (
    <div className={css.layer} data-smart-checkout>
      <div className={css.scrim} aria-hidden="true" onClick={props.onCancel} />
      <div
        ref={props.rootRef}
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('branch.smart.dialogLabel', { target: target.name })}
        tabIndex={-1}
        onKeyDown={props.onKeyDown}
      >
        <header className={css.header}>
          <strong>{t('branch.smart.title')}</strong>
          {canStash ? <span className={css.muted}>{t('branch.smart.count', { count: paths.length })}</span> : null}
        </header>
        <div className={css.body}>
          {canStash ? (
            <>
              <ul className={css.files} aria-label={t('branch.smart.count', { count: paths.length })}>
                {visible.map(path => <li key={path} className={css.file} title={path}>{path}</li>)}
              </ul>
              {more > 0 ? <p className={css.muted}>{t('dirty.more', { count: more })}</p> : null}
              <p className={css.hint}>{t('branch.smart.hint', { target: target.name })}</p>
            </>
          ) : null}
          {untracked.length > 0 ? (
            <div data-untracked-blocking>
              <strong>{t('branch.smart.untrackedTitle', { count: untracked.length })}</strong>
              <ul className={css.files} aria-label={t('branch.smart.untrackedTitle', { count: untracked.length })}>
                {visibleUntracked.map(path => <li key={path} className={css.file} title={path}>{path}</li>)}
              </ul>
              {moreUntracked > 0 ? <p className={css.muted}>{t('dirty.more', { count: moreUntracked })}</p> : null}
              <p className={css.hint}>{t('branch.smart.untrackedHint')}</p>
            </div>
          ) : null}
          <label className={css.check}>
            <input
              type="checkbox"
              checked={props.forceConfirmed}
              onChange={event => props.onForceConfirmChange(event.target.checked)}
            />
            <span>{t(untracked.length > 0 ? 'branch.smart.forceConfirmUntracked' : 'branch.smart.forceConfirm')}</span>
          </label>
          {error === null ? null : <p className={css.error} role="alert">{t(error.key, error.params)}</p>}
          <footer className={css.footer}>
            <span className={css.actions}>
              <Button onClick={props.onCancel} data-cancel>{t('action.cancel')}</Button>
              <Button
                tone="danger"
                disabled={!props.forceConfirmed || busy}
                onClick={event => props.onForce(event.currentTarget)}
                data-force
                data-danger
              >
                {t('branch.smart.force')}
              </Button>
              {canStash ? (
                <Button tone="primary" disabled={busy} onClick={event => props.onStash(event.currentTarget)} data-primary>
                  {busy ? t('branch.sheet.working') : t('branch.smart.stash')}
                </Button>
              ) : null}
            </span>
          </footer>
        </div>
      </div>
    </div>
  )
}

export interface SmartCheckoutSheetProps {
  target: CheckoutTarget
  paths: string[]
  untracked?: string[]
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onClose: () => void
}

export function SmartCheckoutSheet({ target, paths, untracked = [], actions, onOutcome, onClose }: SmartCheckoutSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [forceConfirmed, setForceConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  useEffect(() => { rootRef.current?.focus() }, [])

  const submit = (mode: 'stash' | 'force', trigger: FocusTarget | null): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void submitSmartCheckout(actions, target, mode, trigger)
      .catch((): SmartCheckoutResult => ({ kind: 'error', message: text('action.error.fallback', { code: 'git/exec-failed', message: '' }) }))
      .then((result) => {
        setBusy(false)
        if (result.kind === 'error') {
          setError(result.message)
          return
        }
        onOutcome(result.outcome)
        onClose()
      })
  }

  return (
    <SmartCheckoutSheetView
      t={t}
      target={target}
      paths={paths}
      untracked={untracked}
      forceConfirmed={forceConfirmed}
      busy={busy}
      error={error}
      rootRef={rootRef}
      onStash={(trigger) => { submit('stash', trigger) }}
      onForce={(trigger) => { submit('force', trigger) }}
      onCancel={onClose}
      onForceConfirmChange={setForceConfirmed}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    />
  )
}
