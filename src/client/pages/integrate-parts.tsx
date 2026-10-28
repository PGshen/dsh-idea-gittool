// Small pieces shared by the integrate pages and sheets (A3 T8): footer with verb button, error and
// block lines, Escape handling and the initial focus. Hook-light so the views stay renderable.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode, Ref, RefObject } from 'react'
import type { FocusTarget } from '../focus.ts'
import { activeFocusTarget } from '../focus.ts'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import { text } from '../localized-text.ts'
import type { ActionOutcome } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import type { ActionNotice } from './branch-actions.ts'
import type { IntegrateResult } from './integrate-actions.ts'
import sheetCss from './BranchSheets.module.css'
import css from './Integrate.module.css'
import { trapTab } from './focus-trap.ts'

/** The control that submitted the form (the clicked button, or the focused field after Enter). */
export function submitTriggerOf(event: FormEvent): FocusTarget | null {
  const submitter = (event.nativeEvent as { submitter?: unknown }).submitter
  if (typeof HTMLElement !== 'undefined' && submitter instanceof HTMLElement) return submitter
  return activeFocusTarget()
}

/** Form `onSubmit` that never navigates and hands the trigger to `submit`. */
export function formSubmit(submit: (trigger: FocusTarget | null) => void): (event: FormEvent) => void {
  return (event) => {
    event.preventDefault()
    submit(submitTriggerOf(event))
  }
}

/** Esc goes back one level, except while the action is running (the request cannot be recalled). */
export function escapeHandler(busy: boolean, close: () => void): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (!busy) close()
  }
}

/** Focus the first `[data-autofocus]` control of the root (else the root itself); again when `key` changes. */
export function useInitialFocus(rootRef: RefObject<HTMLElement | null>, key: unknown = true): void {
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const target = root.querySelector<HTMLElement>('[data-autofocus]')
    ;(target ?? root).focus()
  }, [rootRef, key])
}

export function MessageLines({ t, block, error }: { t: Translate; block?: LocalizedText | undefined; error?: LocalizedText | null }): ReactNode {
  return (
    <>
      {block === undefined ? null : <p className={css.blockReason} role="status" data-block>{t(block.key, block.params)}</p>}
      {error === undefined || error === null ? null : <p className={css.error} role="alert">{t(error.key, error.params)}</p>}
    </>
  )
}

export interface FooterProps {
  t: Translate
  /** Verb of the primary button ("合并", "拉取"…). */
  label: string
  busy: boolean
  canSubmit: boolean
  danger?: boolean
  onCancel: () => void
  cancelLabel?: string
  /** Initial focus on Cancel (dangerous forms: Enter must not fire the primary action). */
  focusCancel?: boolean
}

export function IntegrateFooter({ t, label, busy, canSubmit, danger = false, onCancel, cancelLabel, focusCancel = false }: FooterProps): ReactNode {
  return (
    <footer className={css.footer}>
      <span className={css.actions}>
        <Button onClick={onCancel} disabled={busy} data-cancel {...(focusCancel ? { 'data-autofocus': '' } : {})}>
          {cancelLabel ?? t('action.cancel')}
        </Button>
        <Button
          type="submit"
          tone={danger ? 'danger' : 'primary'}
          disabled={!canSubmit || busy}
          data-primary
          {...(danger ? { 'data-danger': true } : {})}
        >
          {busy ? t('branch.sheet.working') : label}
        </Button>
      </span>
    </footer>
  )
}

export interface SheetFrameProps {
  title: string
  subtitle?: string | undefined
  label: string
  rootRef?: Ref<HTMLDivElement>
  onCancel: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
  /** Marks the layer for tests / automation. */
  dataKind: string
}

/** Bottom sheet (design §5.3 level 2) shared by the reset, fetch and commit-operation sheets. */
export function SheetFrame({ title, subtitle, label, rootRef, onCancel, onKeyDown, children, dataKind }: SheetFrameProps): ReactNode {
  return (
    <div className={sheetCss.layer} data-integrate-sheet={dataKind}>
      <div className={sheetCss.scrim} aria-hidden="true" onClick={onCancel} />
      <div ref={rootRef} className={sheetCss.sheet} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={(event) => { onKeyDown?.(event); trapTab(event, event.currentTarget) }}>
        <header className={sheetCss.header}>
          <strong>{title}</strong>
          {subtitle === undefined ? null : <span className={sheetCss.muted}>{subtitle}</span>}
        </header>
        {children}
      </div>
    </div>
  )
}

export interface FormRunnerOptions {
  /** Every finished write (the workbench turns it into a notice). */
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  /** Where a failure goes when the form is gone (the smart-stash question replaced it). */
  onNotice?: (notice: ActionNotice) => void
  onClose: () => void
}

export interface FormRunnerHooks {
  /** Replaces the default `onOutcome` + close on success. */
  closed?: (outcome: ActionOutcome<unknown>) => void
  rewritten?: (localAhead: number) => void
  /** The target the form was built on changed (reset: the HEAD moved). */
  stale?: () => void
}

export interface FormRunner {
  busy: boolean
  error: LocalizedText | null
  clearError: () => void
  run: (task: () => Promise<IntegrateResult>, hooks?: FormRunnerHooks) => void
}

/**
 * Where a finished action goes. `alive` is whether the form is still mounted: a smart operation
 * that asks "stash and continue" replaces the form with the question, so the action may finish
 * after the form is gone. Success is still reported; a failure goes to `onNotice`; the (already
 * replaced) overlay is not closed again.
 */
export function routeResult(
  result: IntegrateResult,
  alive: boolean,
  options: FormRunnerOptions,
  hooks: FormRunnerHooks,
  showError: (message: LocalizedText) => void,
): void {
  switch (result.kind) {
    case 'closed':
      if (hooks.closed === undefined) options.onOutcome(result.outcome)
      else hooks.closed(result.outcome)
      if (alive) options.onClose()
      return
    case 'stay':
      return
    case 'error':
      if (alive) {
        showError(result.message)
        if (result.stale === true) hooks.stale?.()
      } else options.onNotice?.({ tone: 'error', message: result.message })
      return
    case 'rewritten':
      if (alive && hooks.rewritten !== undefined) hooks.rewritten(result.localAhead)
      else options.onNotice?.({ tone: 'error', message: text('action.error.git/upstream-rewritten', { count: result.localAhead }) })
      return
  }
}

/** Busy/error state shared by the integrate forms; results go through {@link routeResult}. */
export function useFormRunner(options: FormRunnerOptions): FormRunner {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const latest = useRef(options)
  latest.current = options
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)

  const run: FormRunner['run'] = (task, hooks = {}) => {
    setBusy(true)
    setError(null)
    task()
      .catch((): IntegrateResult => ({ kind: 'error', message: text('action.error.fallback', { code: 'git/exec-failed', message: '' }) }))
      .then((result) => {
        const alive = mounted.current
        if (alive) setBusy(false)
        routeResult(result, alive, latest.current, hooks, setError)
      })
  }
  return { busy, error, clearError: () => { setError(null) }, run }
}
