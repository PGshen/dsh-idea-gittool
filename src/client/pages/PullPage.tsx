// Pull overlay page (design §11, plan A3 T8): remote, branch and merge / rebase. The mode is the
// last choice (git's `pull.rebase` is not readable from the client, so the default is merge).
import { useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { BranchesValue, PullMode, PushPreviewValue, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import { PULL_MODES, browserStorage, loadPrefs, pullDefaults, savePrefs } from '../store/integrate-store.ts'
import type { KeyValueStorage } from '../store/push-store.ts'
import type { ActionNotice } from './branch-actions.ts'
import { submitPull } from './integrate-actions.ts'
import { IntegrateFooter, MessageLines, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import css from './Integrate.module.css'
import { PushOverlayFrame } from './PushRejectedPage.tsx'
import { useLoaded } from './use-loaded.ts'

export interface PullForm {
  remote: string
  branch: string
  mode: PullMode
}

export function pullCanSubmit(form: PullForm, block: LocalizedText | undefined, busy: boolean): boolean {
  return form.remote !== '' && form.branch.trim() !== '' && block === undefined && !busy
}

/** Remote branch names (without the remote prefix) of `remote`, for the branch suggestions. */
export function remoteBranchNames(branches: BranchesValue | null, remote: string): string[] {
  if (branches === null || remote === '') return []
  const prefix = `${remote}/`
  return branches.remote
    .map(entry => entry.name)
    .filter(name => name.startsWith(prefix) && !name.endsWith('/HEAD'))
    .map(name => name.slice(prefix.length))
}

export interface PullPageViewProps {
  t: Translate
  loading: boolean
  loadError: LocalizedText | null
  remotes: string[]
  branchOptions: string[]
  form: PullForm
  busy: boolean
  error: LocalizedText | null
  block?: LocalizedText | undefined
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<PullForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onBack: () => void
  onRetry: () => void
}

export function PullPageView(props: PullPageViewProps): ReactNode {
  const { t, form, busy } = props
  const canSubmit = pullCanSubmit(form, props.block, busy) && !props.loading
  const title = t('integrate.pull.title')
  return (
    <PushOverlayFrame
      t={t}
      title={title}
      label={title}
      busy={busy}
      rootRef={props.rootRef}
      onBack={props.onBack}
      onKeyDown={escapeHandler(busy, props.onBack)}
    >
      <form className={css.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })} data-integrate="pull">
        {props.loading ? <p className={css.muted} aria-busy="true">{t('integrate.loading')}</p> : null}
        {props.loadError === null
          ? null
          : (
              <p className={css.error} role="alert">
                {t(props.loadError.key, props.loadError.params)}
                {' '}
                <button type="button" onClick={props.onRetry} data-retry>{t('action.retry')}</button>
              </p>
            )}
        <label className={css.field}>
          <span className={css.label}>{t('integrate.pull.remote')}</span>
          <select
            className={css.control}
            value={form.remote}
            disabled={busy || props.loading}
            data-pull-remote
            data-autofocus
            onChange={event => props.onChange({ remote: event.target.value })}
          >
            {props.remotes.length === 0 ? <option value="">{t('integrate.pull.noRemote')}</option> : null}
            {props.remotes.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('integrate.pull.branch')}</span>
          <input
            className={css.control}
            type="text"
            list="git-pull-branches"
            value={form.branch}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            data-pull-branch
            onChange={event => props.onChange({ branch: event.target.value })}
          />
          <datalist id="git-pull-branches">
            {props.branchOptions.map(name => <option key={name} value={name} />)}
          </datalist>
        </label>
        <fieldset className={css.group} disabled={busy}>
          <legend className={css.legend}>{t('integrate.pull.mode')}</legend>
          {PULL_MODES.map(mode => (
            <label key={mode} className={css.choice}>
              <input
                type="radio"
                name="pull-mode"
                checked={form.mode === mode}
                data-pull-mode={mode}
                onChange={() => props.onChange({ mode })}
              />
              <span>
                {t(`integrate.mode.${mode}`)}
                <span className={css.choiceHint}>{t(`integrate.mode.${mode}.hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <MessageLines t={t} block={props.block} error={props.error} />
        <IntegrateFooter t={t} label={t('integrate.pull.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onBack} />
      </form>
    </PushOverlayFrame>
  )
}

export interface PullPageProps {
  /** Prefill from a branch row (the remote name may contain '/', see {@link pullDefaults}). */
  prefill?: { remote?: string | undefined; branch?: string | undefined } | undefined
  branches: BranchesValue | null
  block?: LocalizedText | undefined
  loadRemotes: () => Promise<RpcResult<PushPreviewValue>>
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onNotice: (notice: ActionNotice) => void
  onClose: () => void
  storage?: KeyValueStorage | null
}

export function PullPage({ prefill, branches, block, loadRemotes, actions, onOutcome, onNotice, onClose, storage }: PullPageProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage])
  const loaded = useLoaded(loadRemotes)
  const preview = loaded.state.status === 'ready' ? loaded.state.value : null
  const [rememberedMode] = useState(() => loadPrefs(store).pull)
  const [edits, setEdits] = useState<Partial<PullForm>>({})
  const { busy, error, clearError, run } = useFormRunner({ onOutcome, onNotice, onClose })

  const defaults = useMemo(() => {
    if (preview === null) return { remote: '', branch: '' }
    return pullDefaults({
      remotes: preview.remotes,
      defaultRemote: preview.defaultRemote,
      upstream: preview.upstream,
      branch: preview.branch,
      prefill: prefill?.remote === undefined || prefill.branch === undefined ? undefined : { remote: prefill.remote, branch: prefill.branch },
    })
  }, [preview, prefill?.remote, prefill?.branch])
  const form: PullForm = {
    remote: edits.remote ?? defaults.remote,
    branch: edits.branch ?? defaults.branch,
    mode: edits.mode ?? rememberedMode,
  }
  // A detached HEAD has no current branch to pull into.
  const detached = preview !== null && preview.detached
  const effectiveBlock = block ?? (detached ? text('branch.disabled.detached') : undefined)

  const submit = (trigger: FocusTarget | null): void => {
    if (!pullCanSubmit(form, effectiveBlock, busy)) return
    savePrefs(store, { ...loadPrefs(store), pull: form.mode })
    run(() => submitPull({ actions, trigger }, { remote: form.remote, branch: form.branch.trim(), mode: form.mode }))
  }

  return (
    <PullPageView
      t={t}
      loading={loaded.state.status === 'loading'}
      loadError={loaded.state.status === 'error' ? actionErrorText(loaded.state.error) : null}
      remotes={preview?.remotes ?? []}
      branchOptions={remoteBranchNames(branches, form.remote)}
      form={form}
      busy={busy}
      error={error}
      block={effectiveBlock}
      rootRef={rootRef}
      onChange={(patch) => { setEdits(value => ({ ...value, ...patch })); clearError() }}
      onSubmit={submit}
      onBack={onClose}
      onRetry={loaded.reload}
    />
  )
}
