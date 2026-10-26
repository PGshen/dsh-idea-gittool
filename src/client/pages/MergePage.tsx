// Merge / rebase overlay page (design §11, plan A3 T8): merge = branch + fast-forward / no-ff /
// squash / no-commit; rebase = target branch. Both go through `actions.run` with smart stash.
import { useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { BranchesValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { MERGE_OPTIONS, browserStorage, loadPrefs, savePrefs } from '../store/integrate-store.ts'
import type { MergeOption } from '../store/integrate-store.ts'
import type { KeyValueStorage } from '../store/push-store.ts'
import type { ActionNotice } from './branch-actions.ts'
import { submitMerge, submitRebase } from './integrate-actions.ts'
import { IntegrateFooter, MessageLines, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import css from './Integrate.module.css'
import { PushOverlayFrame } from './PushRejectedPage.tsx'

export type MergePageMode = 'merge' | 'rebase'

export interface MergeForm {
  target: string
  option: MergeOption
}

/** Local branches (not the current one) then remote branches; `preselect` is always listed. */
export function mergeBranchOptions(branches: BranchesValue | null, current: string | null, preselect: string | undefined): string[] {
  const names: string[] = []
  if (branches !== null) {
    for (const entry of branches.local) if (entry.name !== current) names.push(entry.name)
    for (const entry of branches.remote) if (!entry.name.endsWith('/HEAD')) names.push(entry.name)
  }
  if (preselect !== undefined && preselect !== '' && !names.includes(preselect)) names.push(preselect)
  return names
}

export function mergeCanSubmit(form: MergeForm, block: LocalizedText | undefined, busy: boolean): boolean {
  return form.target.trim() !== '' && block === undefined && !busy
}

export interface MergePageViewProps {
  t: Translate
  mode: MergePageMode
  current: string | null
  options: string[]
  form: MergeForm
  busy: boolean
  error: LocalizedText | null
  block?: LocalizedText | undefined
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<MergeForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onBack: () => void
}

export function MergePageView(props: MergePageViewProps): ReactNode {
  const { t, mode, form, busy } = props
  const canSubmit = mergeCanSubmit(form, props.block, busy)
  const current = props.current ?? t('integrate.detachedHead')
  const title = t(mode === 'merge' ? 'integrate.merge.title' : 'integrate.rebase.title')
  return (
    <PushOverlayFrame
      t={t}
      title={title}
      subtitle={current}
      label={title}
      busy={busy}
      rootRef={props.rootRef}
      onBack={props.onBack}
      onKeyDown={escapeHandler(busy, props.onBack)}
    >
      <form className={css.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })} data-integrate={mode}>
        <p className={css.hint}>
          {t(mode === 'merge' ? 'integrate.merge.hint' : 'integrate.rebase.hint', { current })}
        </p>
        <label className={css.field}>
          <span className={css.label}>{t(mode === 'merge' ? 'integrate.merge.target' : 'integrate.rebase.target')}</span>
          <select
            className={css.control}
            value={form.target}
            disabled={busy}
            data-merge-target
            data-autofocus
            onChange={event => props.onChange({ target: event.target.value })}
          >
            <option value="">{t('integrate.target.placeholder')}</option>
            {props.options.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {mode === 'merge'
          ? (
              <fieldset className={css.group} disabled={busy}>
                <legend className={css.legend}>{t('integrate.merge.options')}</legend>
                {MERGE_OPTIONS.map(option => (
                  <label key={option} className={css.choice}>
                    <input
                      type="radio"
                      name="merge-option"
                      checked={form.option === option}
                      data-merge-option={option}
                      onChange={() => props.onChange({ option })}
                    />
                    <span>
                      {t(`integrate.merge.option.${option}`)}
                      <span className={css.choiceHint}>{t(`integrate.merge.option.${option}.hint`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )
          : <p className={css.hint}>{t('integrate.rebase.rewrite')}</p>}
        <MessageLines t={t} block={props.block} error={props.error} />
        <IntegrateFooter
          t={t}
          label={t(mode === 'merge' ? 'integrate.merge.submit' : 'integrate.rebase.submit')}
          busy={busy}
          canSubmit={canSubmit}
          onCancel={props.onBack}
        />
      </form>
    </PushOverlayFrame>
  )
}

export interface MergePageProps {
  mode: MergePageMode
  /** Branch row the page was opened from. */
  preselect?: string | undefined
  branches: BranchesValue | null
  current: string | null
  block?: LocalizedText | undefined
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onNotice: (notice: ActionNotice) => void
  onClose: () => void
  storage?: KeyValueStorage | null
}

export function MergePage({ mode, preselect, branches, current, block, actions, onOutcome, onNotice, onClose, storage }: MergePageProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage])
  const options = useMemo(() => mergeBranchOptions(branches, current, preselect), [branches, current, preselect])
  const [form, setForm] = useState<MergeForm>(() => ({ target: preselect ?? '', option: loadPrefs(store).merge }))
  const { busy, error, clearError, run } = useFormRunner({ onOutcome, onNotice, onClose })

  const submit = (trigger: FocusTarget | null): void => {
    if (!mergeCanSubmit(form, block, busy)) return
    if (mode === 'merge') savePrefs(store, { ...loadPrefs(store), merge: form.option })
    const deps = { actions, trigger }
    run(() => (mode === 'merge' ? submitMerge(deps, { ref: form.target, option: form.option }) : submitRebase(deps, form.target)))
  }

  return (
    <MergePageView
      t={t}
      mode={mode}
      current={current}
      options={options}
      form={form}
      busy={busy}
      error={error}
      block={block}
      rootRef={rootRef}
      onChange={(patch) => { setForm(value => ({ ...value, ...patch })); clearError() }}
      onSubmit={submit}
      onBack={onClose}
    />
  )
}
