// Fetch sheet (design §11, plan A3 T8): all remotes or one, optional prune. After success the
// sheet shows "updated N refs" and a close button. Prune is remembered; nothing risky here.
import { useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { FetchValue, PushPreviewValue, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionStore } from '../store/action-store.ts'
import { browserStorage, loadPrefs, savePrefs } from '../store/integrate-store.ts'
import type { KeyValueStorage } from '../store/push-store.ts'
import { Button } from '../ui/Button.tsx'
import { fetchNotice, submitFetch } from './integrate-actions.ts'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useInitialFocus } from './integrate-parts.tsx'
import sheetCss from './BranchSheets.module.css'
import { useLoaded } from './use-loaded.ts'

export interface FetchForm {
  /** null = all remotes. */
  remote: string | null
  prune: boolean
}

const ALL = ''

export interface FetchSheetViewProps {
  t: Translate
  remotes: string[]
  loading: boolean
  form: FetchForm
  busy: boolean
  error: LocalizedText | null
  /** Set after success: replaces the form with the result and a close button. */
  result: LocalizedText | null
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<FetchForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
}

export function FetchSheetView(props: FetchSheetViewProps): ReactNode {
  const { t, form, busy, result } = props
  const title = t('integrate.fetch.title')
  return (
    <SheetFrame
      dataKind="fetch"
      title={title}
      label={title}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      {result !== null
        ? (
            <form className={sheetCss.body} onSubmit={formSubmit(() => { props.onCancel() })} data-fetch-result>
              <p role="status">{t(result.key, result.params)}</p>
              <footer className={sheetCss.footer}>
                <span className={sheetCss.actions}>
                  <Button type="submit" tone="primary" data-primary data-autofocus>{t('integrate.fetch.close')}</Button>
                </span>
              </footer>
            </form>
          )
        : (
            <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (!busy) props.onSubmit(trigger) })}>
              <label className={sheetCss.field}>
                <span className={sheetCss.label}>{t('integrate.fetch.remote')}</span>
                <select
                  className={sheetCss.control}
                  value={form.remote ?? ALL}
                  disabled={busy}
                  data-fetch-remote
                  data-autofocus
                  onChange={event => props.onChange({ remote: event.target.value === ALL ? null : event.target.value })}
                >
                  <option value={ALL}>{t('integrate.fetch.all')}</option>
                  {props.remotes.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              {props.loading ? <p className={sheetCss.muted} aria-busy="true">{t('integrate.loading')}</p> : null}
              <label className={sheetCss.check}>
                <input
                  type="checkbox"
                  checked={form.prune}
                  disabled={busy}
                  data-fetch-prune
                  onChange={event => props.onChange({ prune: event.target.checked })}
                />
                <span>{t('integrate.fetch.prune')}</span>
              </label>
              <p className={sheetCss.muted}>{t('integrate.fetch.prune.hint')}</p>
              <MessageLines t={t} error={props.error} />
              <IntegrateFooter t={t} label={t('integrate.fetch.submit')} busy={busy} canSubmit onCancel={props.onCancel} />
            </form>
          )}
    </SheetFrame>
  )
}

export interface FetchSheetProps {
  loadRemotes: () => Promise<RpcResult<PushPreviewValue>>
  actions: Pick<ActionStore, 'run'>
  onClose: () => void
  storage?: KeyValueStorage | null
}

export function FetchSheet({ loadRemotes, actions, onClose, storage }: FetchSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage])
  const loaded = useLoaded(loadRemotes)
  const [form, setForm] = useState<FetchForm>(() => ({ remote: null, prune: loadPrefs(store).prune }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const [result, setResult] = useState<LocalizedText | null>(null)
  // Re-run the focus pick when the result replaces the form.
  useInitialFocus(rootRef, result === null)

  const submit = (trigger: FocusTarget | null): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    savePrefs(store, { ...loadPrefs(store), prune: form.prune })
    void submitFetch({ actions, trigger }, form)
      .catch(() => ({ kind: 'error' as const, message: text('action.error.fallback', { code: 'git/exec-failed', message: '' }) }))
      .then((outcome) => {
        setBusy(false)
        if (outcome.kind === 'closed') {
          const value = outcome.outcome.kind === 'done' ? (outcome.outcome.value as Partial<FetchValue>) : {}
          setResult(fetchNotice(value))
        } else if (outcome.kind === 'error') setError(outcome.message)
      })
  }

  return (
    <FetchSheetView
      t={t}
      remotes={loaded.state.status === 'ready' ? loaded.state.value.remotes : []}
      loading={loaded.state.status === 'loading'}
      form={form}
      busy={busy}
      error={error}
      result={result}
      rootRef={rootRef}
      onChange={(patch) => { setForm(value => ({ ...value, ...patch })); setError(null) }}
      onSubmit={submit}
      onCancel={onClose}
    />
  )
}
