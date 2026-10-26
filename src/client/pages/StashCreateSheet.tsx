// "Create stash…" sheet (design §8.4.1, plan A3 T10): message (placeholder = the Host's default
// message), include untracked files, keep the index. "Nothing to stash" is shown inside the sheet.
import { useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import type { ActionNotice } from './branch-actions.ts'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import { submitStashCreate } from './stash-actions.ts'
import type { StashCreateForm } from './stash-actions.ts'
import sheetCss from './BranchSheets.module.css'

export const INITIAL_STASH_FORM: StashCreateForm = { message: '', includeUntracked: false, keepIndex: false }

export function stashCreateCanSubmit(block: LocalizedText | undefined, busy: boolean): boolean {
  return block === undefined && !busy
}

export interface StashCreateSheetViewProps {
  t: Translate
  /** Current branch for the placeholder (`WIP on <branch>: …`). */
  branch: string
  form: StashCreateForm
  busy: boolean
  error: LocalizedText | null
  block?: LocalizedText | undefined
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<StashCreateForm>) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
}

export function StashCreateSheetView(props: StashCreateSheetViewProps): ReactNode {
  const { t, form, busy, block } = props
  const canSubmit = stashCreateCanSubmit(block, busy)
  const title = t('stash.create.title')
  return (
    <SheetFrame
      dataKind="stashCreate"
      title={title}
      label={title}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <label className={sheetCss.field}>
          <span className={sheetCss.label}>{t('stash.create.message')}</span>
          <input
            className={sheetCss.control}
            type="text"
            value={form.message}
            placeholder={t('stash.create.placeholder', { branch: props.branch })}
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            data-stash-message
            onChange={event => props.onChange({ message: event.target.value })}
          />
        </label>
        <label className={sheetCss.check}>
          <input
            type="checkbox"
            checked={form.includeUntracked}
            data-include-untracked
            onChange={event => props.onChange({ includeUntracked: event.target.checked })}
          />
          <span>{t('stash.create.includeUntracked')}</span>
        </label>
        <label className={sheetCss.check}>
          <input
            type="checkbox"
            checked={form.keepIndex}
            data-keep-index
            onChange={event => props.onChange({ keepIndex: event.target.checked })}
          />
          <span>{t('stash.create.keepIndex')}</span>
        </label>
        <p className={sheetCss.hint}>{t('stash.create.keepIndex.hint')}</p>
        <MessageLines t={t} block={block} error={props.error} />
        <IntegrateFooter t={t} label={t('stash.create.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export interface StashCreateSheetProps {
  branch: string
  block?: LocalizedText | undefined
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onNotice: (notice: ActionNotice) => void
  onClose: () => void
}

export function StashCreateSheet({ branch, block, actions, onOutcome, onNotice, onClose }: StashCreateSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const [form, setForm] = useState<StashCreateForm>(INITIAL_STASH_FORM)
  const { busy, error, clearError, run } = useFormRunner({ onOutcome, onNotice, onClose })

  const submit = (trigger: FocusTarget | null): void => {
    if (!stashCreateCanSubmit(block, busy)) return
    run(() => submitStashCreate({ actions, trigger }, form))
  }

  return (
    <StashCreateSheetView
      t={t}
      branch={branch}
      form={form}
      busy={busy}
      error={error}
      block={block}
      rootRef={rootRef}
      onChange={(patch) => {
        clearError()
        setForm(current => ({ ...current, ...patch }))
      }}
      onSubmit={submit}
      onCancel={onClose}
    />
  )
}
