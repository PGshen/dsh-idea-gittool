// B3b commit-menu forms (design §8.1.7, §11): new tag (sheet), fixup / squash checked files into a commit
// (sheet), export commits as a patch (page: preview, download, copy) and apply a patch (page: paste or
// choose a file, preview the files, apply). Views are hook-free for static rendering; containers own
// the RPC calls and go through the action store for writes.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { ApplyPatchValue, FormatPatchValue, GitError, InteractiveRebaseValue, RpcResult } from '../../shared/protocol.ts'
import { APPLY_PATCH_MAX_BYTES } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { render } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import sheetCss from './BranchSheets.module.css'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useInitialFocus } from './integrate-parts.tsx'
import css from './CommitMenuSheets.module.css'

type Actions = Pick<ActionStore, 'run'>

/** Error text of a failed write outcome, or null. */
function failureOf(outcome: ActionOutcome<unknown>): LocalizedText | null {
  return outcome.kind === 'failed' ? outcome.message : outcome.kind === 'conflict' ? actionErrorText(outcome.error) : null
}

// ---------------------------------------------------------------------------
// New tag
// ---------------------------------------------------------------------------

export interface CreateTagSheetViewProps {
  t: Translate
  shortSha: string
  name: string
  message: string
  busy: boolean
  error: LocalizedText | null
  onChange: (patch: { name?: string; message?: string }) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
  rootRef?: Ref<HTMLDivElement>
}

/** A tag name the form accepts before git checks it (`check-ref-format` runs on the Host). */
export function tagNameProblem(name: string): LocalizedText | null {
  const trimmed = name.trim()
  if (trimmed === '') return { key: 'tag.invalid.empty' }
  if (trimmed.startsWith('-') || /\s/u.test(trimmed)) return { key: 'tag.invalid.format' }
  return null
}

export function CreateTagSheetView(props: CreateTagSheetViewProps): ReactNode {
  const { t, busy } = props
  const problem = tagNameProblem(props.name)
  return (
    <SheetFrame
      dataKind="createTag"
      title={t('tag.title')}
      subtitle={props.shortSha}
      label={t('tag.dialog', { sha: props.shortSha })}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (problem === null && !busy) props.onSubmit(trigger) })}>
        <label className={sheetCss.field}>
          <span>{t('tag.name')}</span>
          <input value={props.name} disabled={busy} data-autofocus="" data-tag-name onChange={event => props.onChange({ name: event.target.value })} />
        </label>
        <label className={sheetCss.field}>
          <span>{t('tag.message')}</span>
          <textarea value={props.message} disabled={busy} rows={3} data-tag-message onChange={event => props.onChange({ message: event.target.value })} />
          <span className={sheetCss.muted}>{t('tag.message.hint')}</span>
        </label>
        <MessageLines t={t} block={props.name.trim() === '' ? undefined : problem ?? undefined} error={props.error} />
        <IntegrateFooter t={t} label={t('tag.submit')} busy={busy} canSubmit={problem === null && !busy} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function CreateTagSheet(props: { sha: string; shortSha: string; actions: Actions; onOutcome: (outcome: ActionOutcome<unknown>) => void; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const [form, setForm] = useState({ name: '', message: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const submit = async (trigger: FocusTarget | null): Promise<void> => {
    setBusy(true)
    setError(null)
    const message = form.message.trim()
    const outcome = await props.actions.run(
      'createTag',
      { name: form.name.trim(), target: props.sha, ...(message === '' ? {} : { message }) },
      { target: `tag:${form.name.trim()}`, trigger },
    )
    setBusy(false)
    const failure = failureOf(outcome)
    if (failure !== null) {
      setError(failure)
      return
    }
    if (outcome.kind === 'done') {
      props.onOutcome(outcome)
      props.onClose()
    }
  }
  return (
    <CreateTagSheetView
      t={t}
      shortSha={props.shortSha}
      name={form.name}
      message={form.message}
      busy={busy}
      error={error}
      rootRef={rootRef}
      onChange={(patch) => { setForm(value => ({ ...value, ...patch })); setError(null) }}
      onSubmit={(trigger) => { void submit(trigger) }}
      onCancel={props.onClose}
    />
  )
}

// ---------------------------------------------------------------------------
// Fixup / squash into
// ---------------------------------------------------------------------------

export interface FixupIntoSheetViewProps {
  t: Translate
  mode: 'fixup' | 'squash'
  shortSha: string
  subject: string
  paths: readonly string[]
  message: string
  busy: boolean
  error: LocalizedText | null
  onMessage: (message: string) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
  rootRef?: Ref<HTMLDivElement>
}

export function FixupIntoSheetView(props: FixupIntoSheetViewProps): ReactNode {
  const { t, busy } = props
  const canSubmit = props.paths.length > 0 && !busy
  return (
    <SheetFrame
      dataKind="fixupInto"
      title={t(props.mode === 'fixup' ? 'fixup.title' : 'squash.title')}
      subtitle={`${props.shortSha} ${props.subject}`}
      label={t(props.mode === 'fixup' ? 'fixup.title' : 'squash.title')}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <p className={sheetCss.hint}>{t('fixup.files', { count: props.paths.length })}</p>
        <ul className={sheetCss.files}>
          {props.paths.map(path => <li key={path} className={sheetCss.file} title={path}>{path}</li>)}
        </ul>
        {props.mode === 'squash'
          ? (
              <label className={sheetCss.field}>
                <span>{t('squash.message')}</span>
                <textarea value={props.message} rows={3} disabled={busy} data-autofocus="" onChange={event => props.onMessage(event.target.value)} />
              </label>
            )
          : null}
        <p className={sheetCss.muted}>{t('fixup.explain')}</p>
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t(props.mode === 'fixup' ? 'fixup.submit' : 'squash.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function FixupIntoSheet(props: {
  sha: string
  shortSha: string
  subject: string
  mode: 'fixup' | 'squash'
  paths: readonly string[]
  actions: Actions
  onDone: (value: InteractiveRebaseValue, trigger: FocusTarget | null) => void
  onClose: () => void
}): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const submit = async (trigger: FocusTarget | null): Promise<void> => {
    setBusy(true)
    setError(null)
    const extra = message.trim()
    const outcome = await props.actions.run(
      'fixupCommit',
      { target: props.sha, paths: [...props.paths], kind: props.mode, ...(props.mode === 'squash' && extra !== '' ? { message: extra } : {}) },
      { smartStash: 'rebase', target: 'interactive-rebase', trigger },
    )
    setBusy(false)
    if (outcome.kind === 'done') props.onDone(outcome.value, trigger)
    else setError(failureOf(outcome))
  }
  return (
    <FixupIntoSheetView
      t={t}
      mode={props.mode}
      shortSha={props.shortSha}
      subject={props.subject}
      paths={props.paths}
      message={message}
      busy={busy}
      error={error}
      rootRef={rootRef}
      onMessage={setMessage}
      onSubmit={(trigger) => { void submit(trigger) }}
      onCancel={props.onClose}
    />
  )
}

// ---------------------------------------------------------------------------
// Create patch
// ---------------------------------------------------------------------------

/** Offer `text` as a file download (browser only; no Host write, plan b3b 待确认 2). */
export function downloadText(fileName: string, text: string): void {
  const doc = globalThis.document
  if (doc === undefined || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([text], { type: 'text/x-patch' }))
  const link = doc.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export interface PatchPageViewProps {
  t: Translate
  count: number
  value: FormatPatchValue | null
  error: GitError | null
  onBack: () => void
  onRetry: () => void
  onDownload: () => void
  onCopy: () => void
}

export function PatchPageView(props: PatchPageViewProps): ReactNode {
  const { t } = props
  let body: ReactNode
  if (props.error !== null) {
    body = <div className={css.state}><EmptyState error title={t('patch.loadFailed')} hint={render(t, actionErrorText(props.error))} action={{ label: t('action.retry'), onClick: props.onRetry }} /></div>
  } else if (props.value === null) {
    body = <p className={css.state} role="status">{t('patch.loading')}</p>
  } else {
    body = <pre className={css.preview} data-patch-preview>{props.value.patch}</pre>
  }
  return (
    <div className={css.root} role="dialog" aria-label={t('patch.title', { count: props.count })} tabIndex={-1} data-patch-page>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('patch.title', { count: props.count })}</span>
        {props.value === null ? null : <span className={css.muted}>{props.value.fileName}</span>}
        <Button disabled={props.value === null} onClick={props.onCopy}>{t('patch.copy')}</Button>
        <Button tone="primary" disabled={props.value === null} onClick={props.onDownload}>{t('patch.download')}</Button>
      </div>
      {body}
    </div>
  )
}

export function PatchPage(props: {
  shas: readonly string[]
  load: (shas: string[], signal: AbortSignal) => Promise<RpcResult<FormatPatchValue>>
  onBack: () => void
  onCopy?: (text: string) => void
}): ReactNode {
  const t = useT()
  const [result, setResult] = useState<RpcResult<FormatPatchValue> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = props.shas.join(',')
  const loadRef = useRef(props.load)
  loadRef.current = props.load
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    void loadRef.current(key.split(','), controller.signal).then((next) => { if (!controller.signal.aborted) setResult(next) })
    return () => { controller.abort() }
  }, [key, attempt])
  const value = result?.ok === true ? result.value : null
  const copy = props.onCopy ?? ((text: string) => { void globalThis.navigator?.clipboard?.writeText(text) })
  return (
    <PatchPageView
      t={t}
      count={props.shas.length}
      value={value}
      error={result?.ok === false ? result.error : null}
      onBack={props.onBack}
      onRetry={() => { setAttempt(value_ => value_ + 1) }}
      onDownload={() => { if (value !== null) downloadText(value.fileName, value.patch) }}
      onCopy={() => { if (value !== null) copy(value.patch) }}
    />
  )
}

// ---------------------------------------------------------------------------
// Apply patch
// ---------------------------------------------------------------------------

export interface ApplyPatchPageViewProps {
  t: Translate
  patch: string
  preview: ApplyPatchValue | null
  busy: boolean
  error: LocalizedText | null
  done: ApplyPatchValue | null
  onPatch: (text: string) => void
  onFile: (file: File) => void
  onPreview: () => void
  onApply: (trigger: FocusTarget | null) => void
  onBack: () => void
}

/** Why the pasted text cannot be sent, or null. */
export function patchTextProblem(patch: string): LocalizedText | null {
  if (patch.trim() === '') return { key: 'applyPatch.empty' }
  if (new TextEncoder().encode(patch).byteLength > APPLY_PATCH_MAX_BYTES) return { key: 'applyPatch.tooLarge' }
  return null
}

export function ApplyPatchPageView(props: ApplyPatchPageViewProps): ReactNode {
  const { t, preview, busy } = props
  const problem = patchTextProblem(props.patch)
  return (
    <div className={css.root} role="dialog" aria-label={t('applyPatch.title')} tabIndex={-1} data-apply-patch>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('applyPatch.title')}</span>
        <label className={css.file}>
          {t('applyPatch.chooseFile')}
          <input type="file" accept=".patch,.diff,.txt,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) props.onFile(file) }} />
        </label>
      </div>
      <textarea
        className={css.input}
        value={props.patch}
        placeholder={t('applyPatch.placeholder')}
        spellCheck={false}
        disabled={busy}
        data-patch-input
        onChange={event => props.onPatch(event.target.value)}
      />
      <div className={css.footer}>
        {props.done !== null
          ? <p className={css.success} role="status">{t(props.done.format === 'mbox' ? 'applyPatch.done.mbox' : 'applyPatch.done.diff', { count: props.done.commits ?? props.done.files.length })}</p>
          : null}
        {preview === null
          ? null
          : (
              <div data-patch-files>
                <p className={css.muted}>{t(preview.format === 'mbox' ? 'applyPatch.preview.mbox' : 'applyPatch.preview.diff', { count: preview.commits ?? 0, files: preview.files.length })}</p>
                <ul className={css.files}>{preview.files.map(file => <li key={file}>{file}</li>)}</ul>
              </div>
            )}
        {props.error === null ? null : <p className={css.error} role="alert">{render(t, props.error)}</p>}
        <div className={css.actions}>
          <span className={css.muted}>{problem === null || props.patch === '' ? '' : render(t, problem)}</span>
          <Button disabled={problem !== null || busy} onClick={props.onPreview}>{t('applyPatch.preview')}</Button>
          <Button tone="primary" disabled={problem !== null || busy || preview === null} onClick={(event) => { props.onApply(event.currentTarget) }}>
            {t('applyPatch.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ApplyPatchPage(props: { actions: Actions; onBack: () => void; onApplied: () => void }): ReactNode {
  const t = useT()
  const [patch, setPatch] = useState('')
  const [preview, setPreview] = useState<ApplyPatchValue | null>(null)
  const [done, setDone] = useState<ApplyPatchValue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  const change = (text: string): void => {
    setPatch(text)
    setPreview(null)
    setDone(null)
    setError(null)
  }
  const send = async (check: boolean, trigger: FocusTarget | null): Promise<void> => {
    setBusy(true)
    setError(null)
    const outcome = await props.actions.run('applyPatch', { patch, check }, { target: check ? 'apply-patch-check' : 'apply-patch', trigger })
    setBusy(false)
    if (outcome.kind !== 'done') {
      setError(failureOf(outcome))
      return
    }
    if (check) setPreview(outcome.value)
    else {
      setDone(outcome.value)
      setPreview(null)
      props.onApplied()
    }
  }
  return (
    <ApplyPatchPageView
      t={t}
      patch={patch}
      preview={preview}
      busy={busy}
      error={error}
      done={done}
      onPatch={change}
      onFile={(file) => { void file.text().then(change) }}
      onPreview={() => { void send(true, null) }}
      onApply={(trigger) => { void send(false, trigger) }}
      onBack={props.onBack}
    />
  )
}
