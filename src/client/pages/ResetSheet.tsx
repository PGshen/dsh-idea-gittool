// Reset sheet (design §11, plan A3 T8): target commit, soft / mixed / hard with their effect, the
// commits that would be lost (`resetPreview`), and for hard the discard count plus a risk tick.
// Sends the HEAD the user saw as `expectedHead`; the tick is never remembered.
import { useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { ResetPreviewValue, ResetPreviewRequest, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import { RESET_MODES, browserStorage, loadPrefs, savePrefs } from '../store/integrate-store.ts'
import type { KeyValueStorage } from '../store/push-store.ts'
import { resetCanSubmit, submitReset } from './integrate-actions.ts'
import type { ResetForm } from './integrate-actions.ts'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import sheetCss from './BranchSheets.module.css'
import { useLoaded } from './use-loaded.ts'

export interface ResetSheetViewProps {
  t: Translate
  sha: string
  preview: ResetPreviewValue | null
  loading: boolean
  loadError: LocalizedText | null
  form: ResetForm
  busy: boolean
  error: LocalizedText | null
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<ResetForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
  onRetry: () => void
}

export function ResetSheetView(props: ResetSheetViewProps): ReactNode {
  const { t, preview, form, busy } = props
  const canSubmit = resetCanSubmit(form, preview) && !busy
  const hard = form.mode === 'hard'
  const label = t('integrate.reset.title')
  return (
    <SheetFrame
      dataKind="reset"
      title={label}
      subtitle={props.sha.slice(0, 7)}
      label={t('integrate.reset.dialogLabel', { sha: props.sha.slice(0, 7) })}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <fieldset disabled={busy} className={sheetCss.modes}>
          {RESET_MODES.map(mode => (
            <label key={mode} className={sheetCss.check}>
              <input
                type="radio"
                name="reset-mode"
                checked={form.mode === mode}
                data-reset-mode={mode}
                data-autofocus={form.mode === mode ? '' : undefined}
                onChange={() => props.onChange({ mode, hardConfirmed: false })}
              />
              <span>
                {t(`integrate.reset.mode.${mode}`)}
                <span className={sheetCss.muted}> — {t(`integrate.reset.mode.${mode}.hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {props.loading ? <p className={sheetCss.muted} aria-busy="true">{t('integrate.loading')}</p> : null}
        {props.loadError === null
          ? null
          : (
              <p className={sheetCss.error} role="alert">
                {t(props.loadError.key, props.loadError.params)}
                {' '}
                <button type="button" onClick={props.onRetry} data-retry>{t('action.retry')}</button>
              </p>
            )}
        {preview === null
          ? null
          : (
              <>
                {preview.commitsLost.length === 0
                  ? <p className={sheetCss.muted}>{t('integrate.reset.noLoss')}</p>
                  : (
                      <>
                        <p className={sheetCss.hint}>{t('integrate.reset.lostCommits', { count: preview.commitsLost.length })}</p>
                        <ul className={sheetCss.files} aria-label={t('integrate.reset.lostCommits', { count: preview.commitsLost.length })}>
                          {preview.commitsLost.map(commit => (
                            <li key={commit.sha} className={sheetCss.file} title={commit.subject} data-lost-commit={commit.sha}>
                              {commit.shortSha} {commit.subject}
                            </li>
                          ))}
                        </ul>
                        {preview.truncated ? <p className={sheetCss.muted}>{t('integrate.reset.truncated')}</p> : null}
                      </>
                    )}
                {hard
                  ? (
                      <div className={sheetCss.danger} data-reset-risk>
                        <p className={sheetCss.warning}>{t('integrate.reset.discard', { count: preview.discardCount })}</p>
                        <label className={sheetCss.check}>
                          <input
                            type="checkbox"
                            checked={form.hardConfirmed}
                            disabled={busy}
                            data-reset-confirm
                            onChange={event => props.onChange({ hardConfirmed: event.target.checked })}
                          />
                          <span>{t('integrate.reset.confirm')}</span>
                        </label>
                      </div>
                    )
                  : null}
              </>
            )}
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter
          t={t}
          label={t(hard ? 'integrate.reset.submitHard' : 'integrate.reset.submit')}
          busy={busy}
          canSubmit={canSubmit}
          danger={hard}
          onCancel={props.onCancel}
        />
      </form>
    </SheetFrame>
  )
}

export interface ResetSheetProps {
  sha: string
  loadPreview: (request: Omit<ResetPreviewRequest, 'sessionId'>) => Promise<RpcResult<ResetPreviewValue>>
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onClose: () => void
  storage?: KeyValueStorage | null
}

export function ResetSheet({ sha, loadPreview, actions, onOutcome, onClose, storage }: ResetSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage])
  const loaded = useLoaded(() => loadPreview({ sha }))
  const preview = loaded.state.status === 'ready' ? loaded.state.value : null
  const [form, setForm] = useState<ResetForm>(() => ({ mode: loadPrefs(store).reset, hardConfirmed: false }))
  const { busy, error, clearError, run } = useFormRunner({ onOutcome, onClose })

  const submit = (trigger: FocusTarget | null): void => {
    if (busy || !resetCanSubmit(form, preview)) return
    savePrefs(store, { ...loadPrefs(store), reset: form.mode === 'soft' ? 'soft' : 'mixed' })
    run(() => submitReset({ actions, trigger }, { ...form, sha }, preview), {
      // The preview is out of date: load it again and drop the tick, so the user sees the new
      // HEAD's consequences before confirming anything.
      stale: () => {
        setForm(value => ({ ...value, hardConfirmed: false }))
        loaded.reload()
      },
    })
  }

  return (
    <ResetSheetView
      t={t}
      sha={sha}
      preview={preview}
      loading={loaded.state.status === 'loading'}
      loadError={loaded.state.status === 'error' ? actionErrorText(loaded.state.error) : null}
      form={form}
      busy={busy}
      error={error}
      rootRef={rootRef}
      onChange={(patch) => { setForm(value => ({ ...value, ...patch })); clearError() }}
      onSubmit={submit}
      onCancel={onClose}
      onRetry={loaded.reload}
    />
  )
}
