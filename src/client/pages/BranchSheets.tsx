// Branch sheets (design §11, plan A3 T7): new branch, rename, delete (with a forced stage for
// unmerged branches) and "checkout tag or revision". One component per overlay kind `branchSheet`;
// the submit logic is a pure async function so it can be tested without a DOM.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import { validateBranchName } from './branch-actions.ts'
import type { BranchActionRunner } from './branch-actions.ts'
import { shortSha } from './branch-store.ts'
import css from './BranchSheets.module.css'
import type { WorkbenchOverlay } from './workbench-overlay.ts'
import { trapTab } from './focus-trap.ts'

export type BranchSheetOverlay = Extract<WorkbenchOverlay, { kind: 'branchSheet' }>

export interface SheetForm {
  /** New branch name (new) or the new name (rename). */
  name: string
  /** New branch: check it out after creating. */
  checkout: boolean
  /** Checkout revision: tag, branch or hash. */
  revision: string
  /** Delete: the forced (`-D`) stage after `git/not-merged`. */
  force: boolean
  /** Delete: the user ticked the force-delete confirmation. */
  forceConfirmed: boolean
}

export function initialSheetForm(overlay: BranchSheetOverlay): SheetForm {
  return {
    name: overlay.mode === 'rename' ? (overlay.branch ?? '') : '',
    checkout: true,
    revision: overlay.revision ?? '',
    force: false,
    forceConfirmed: false,
  }
}

/** Whether the primary button may be pressed (the Host's `check-ref-format` stays authoritative). */
export function sheetCanSubmit(overlay: BranchSheetOverlay, form: SheetForm): boolean {
  switch (overlay.mode) {
    case 'new':
      return form.name.trim() !== '' && validateBranchName(form.name) === null
    case 'rename':
      return form.name.trim() !== '' && form.name.trim() !== overlay.branch && validateBranchName(form.name) === null
    case 'delete':
      return !form.force || form.forceConfirmed
    case 'checkoutRevision':
      return form.revision.trim() !== ''
  }
}

export type SheetResult =
  | { kind: 'closed' }
  /** Stay open and show `message`; `needsForce` switches a delete to its forced stage. */
  | { kind: 'error'; message: LocalizedText; needsForce?: true }
  /** The smart checkout sheet replaced this one. */
  | { kind: 'handedOff' }

export interface BranchSheetDeps {
  actions: Pick<ActionStore, 'run'>
  runner: Pick<BranchActionRunner, 'checkout'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  trigger: FocusTarget | null
}

function failure(outcome: ActionOutcome<unknown>): SheetResult | null {
  if (outcome.kind === 'failed') return { kind: 'error', message: outcome.message }
  return null
}

export async function submitBranchSheet(deps: BranchSheetDeps, overlay: BranchSheetOverlay, form: SheetForm): Promise<SheetResult> {
  const { actions, trigger } = deps
  let outcome: ActionOutcome<unknown>
  switch (overlay.mode) {
    case 'new':
      outcome = await actions.run(
        'createBranch',
        { name: form.name.trim(), startPoint: overlay.startPoint ?? 'HEAD', checkout: form.checkout },
        { trigger },
      )
      break
    case 'rename':
      outcome = await actions.run('renameBranch', { from: overlay.branch ?? '', to: form.name.trim() }, { trigger })
      break
    case 'delete': {
      const name = overlay.branch ?? ''
      outcome = await actions.run(
        'deleteBranch',
        { name, force: form.force, ...(overlay.sha === undefined ? {} : { expectedSha: overlay.sha }) },
        { trigger },
      )
      if (outcome.kind === 'failed' && outcome.error.code === 'git/not-merged' && !form.force) {
        return { kind: 'error', message: outcome.message, needsForce: true }
      }
      break
    }
    case 'checkoutRevision': {
      const result = await deps.runner.checkout({ kind: 'revision', name: form.revision.trim() }, trigger, { report: false })
      if (result === 'smart') return { kind: 'handedOff' }
      outcome = result
      break
    }
  }
  const failed = failure(outcome)
  if (failed !== null) return failed
  deps.onOutcome(outcome)
  return { kind: 'closed' }
}

const TITLE = {
  new: 'branch.sheet.new.title',
  rename: 'branch.sheet.rename.title',
  delete: 'branch.sheet.delete.title',
  checkoutRevision: 'branch.sheet.checkoutRevision.title',
} as const

const PRIMARY = {
  new: 'branch.sheet.create',
  rename: 'branch.sheet.rename',
  delete: 'branch.sheet.delete',
  checkoutRevision: 'branch.sheet.checkout',
} as const

export interface BranchSheetViewProps {
  t: Translate
  overlay: BranchSheetOverlay
  form: SheetForm
  busy: boolean
  error: LocalizedText | null
  rootRef?: Ref<HTMLDivElement>
  inputRef?: Ref<HTMLInputElement>
  onChange: (patch: Partial<SheetForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function BranchSheetView(props: BranchSheetViewProps): ReactNode {
  const { t, overlay, form, busy, error, onChange } = props
  const branch = overlay.branch ?? ''
  const invalid = overlay.mode === 'new' || overlay.mode === 'rename' ? validateBranchName(form.name) : null
  const canSubmit = sheetCanSubmit(overlay, form) && !busy
  const forced = overlay.mode === 'delete' && form.force
  const primaryLabel = forced ? t('branch.sheet.forceDelete') : t(PRIMARY[overlay.mode])
  const submitFromInput = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || !canSubmit) return
    event.preventDefault()
    props.onSubmit(event.currentTarget)
  }
  return (
    <div className={css.layer} data-branch-sheet={overlay.mode}>
      <div className={css.scrim} aria-hidden="true" onClick={props.onCancel} />
      <div
        ref={props.rootRef}
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t(TITLE[overlay.mode])}
        tabIndex={-1}
        onKeyDown={(event) => { props.onKeyDown?.(event); trapTab(event, event.currentTarget) }}
      >
        <header className={css.header}>
          <strong>{t(TITLE[overlay.mode])}</strong>
        </header>
        <div className={css.body}>
          {overlay.mode === 'new'
            ? (
                <>
                  <label className={css.field}>
                    <span className={css.label}>{t('branch.sheet.name')}</span>
                    <input
                      ref={props.inputRef}
                      className={css.control}
                      type="text"
                      value={form.name}
                      aria-invalid={invalid !== null}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={event => onChange({ name: event.target.value })}
                      onKeyDown={submitFromInput}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.label}>{t('branch.sheet.startPoint')}</span>
                    <input className={css.control} type="text" value={overlay.startPoint ?? 'HEAD'} readOnly data-start-point />
                  </label>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={form.checkout}
                      onChange={event => onChange({ checkout: event.target.checked })}
                    />
                    <span>{t('branch.sheet.checkoutAfter')}</span>
                  </label>
                </>
              )
            : null}
          {overlay.mode === 'rename'
            ? (
                <label className={css.field}>
                  <span className={css.label}>{t('branch.sheet.newName')}</span>
                  <input
                    ref={props.inputRef}
                    className={css.control}
                    type="text"
                    value={form.name}
                    aria-invalid={invalid !== null}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => onChange({ name: event.target.value })}
                    onKeyDown={submitFromInput}
                  />
                </label>
              )
            : null}
          {overlay.mode === 'delete'
            ? (
                <>
                  <p className={css.hint}>{t('branch.sheet.delete.hint', { name: branch, sha: shortSha(overlay.sha ?? '') })}</p>
                  {forced
                    ? (
                        <div className={css.danger}>
                          <p className={css.warning}>{t('branch.sheet.delete.notMerged', { name: branch })}</p>
                          <label className={css.check}>
                            <input
                              type="checkbox"
                              checked={form.forceConfirmed}
                              onChange={event => onChange({ forceConfirmed: event.target.checked })}
                            />
                            <span>{t('branch.sheet.delete.forceConfirm', { name: branch })}</span>
                          </label>
                        </div>
                      )
                    : null}
                </>
              )
            : null}
          {overlay.mode === 'checkoutRevision'
            ? (
                <>
                  <label className={css.field}>
                    <span className={css.label}>{t('branch.sheet.revision')}</span>
                    <input
                      ref={props.inputRef}
                      className={css.control}
                      type="text"
                      value={form.revision}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={event => onChange({ revision: event.target.value })}
                      onKeyDown={submitFromInput}
                    />
                  </label>
                  <p className={css.muted}>{t('branch.sheet.revision.hint')}</p>
                </>
              )
            : null}
          {invalid === null ? null : <p className={css.invalid} role="status">{t(invalid.key, invalid.params)}</p>}
          {error === null ? null : <p className={css.error} role="alert">{t(error.key, error.params)}</p>}
          <footer className={css.footer}>
            <span className={css.actions}>
              <Button onClick={props.onCancel} data-cancel>{t('action.cancel')}</Button>
              <Button
                tone={forced ? 'danger' : 'primary'}
                disabled={!canSubmit}
                onClick={event => props.onSubmit(event.currentTarget)}
                data-primary
                {...(forced ? { 'data-danger': true } : {})}
              >
                {busy ? t('branch.sheet.working') : primaryLabel}
              </Button>
            </span>
          </footer>
        </div>
      </div>
    </div>
  )
}

export interface BranchSheetProps {
  overlay: BranchSheetOverlay
  actions: Pick<ActionStore, 'run'>
  runner: Pick<BranchActionRunner, 'checkout'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onClose: () => void
}

export function BranchSheet({ overlay, actions, runner, onOutcome, onClose }: BranchSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [form, setForm] = useState<SheetForm>(() => initialSheetForm(overlay))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  useEffect(() => {
    // Text sheets start in the field; the delete sheet has none, so the dialog itself takes focus.
    if (inputRef.current !== null) {
      inputRef.current.focus()
      inputRef.current.select()
    } else {
      rootRef.current?.focus()
    }
  }, [])

  const submit = (trigger: FocusTarget | null): void => {
    if (busy || !sheetCanSubmit(overlay, form)) return
    setBusy(true)
    setError(null)
    void submitBranchSheet({ actions, runner, onOutcome, trigger }, overlay, form)
      .catch((): SheetResult => ({ kind: 'error', message: text('action.error.fallback', { code: 'git/exec-failed', message: '' }) }))
      .then((result) => {
        setBusy(false)
        if (result.kind === 'closed') onClose()
        else if (result.kind === 'error') {
          setError(result.message)
          if (result.needsForce === true) setForm(current => ({ ...current, force: true, forceConfirmed: false }))
        }
      })
  }

  return (
    <BranchSheetView
      t={t}
      overlay={overlay}
      form={form}
      busy={busy}
      error={error}
      rootRef={rootRef}
      inputRef={inputRef}
      onChange={(patch) => { setForm(current => ({ ...current, ...patch })); setError(null) }}
      onSubmit={submit}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    />
  )
}
