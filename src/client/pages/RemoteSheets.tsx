// B3d sheets (design §8.3.4, §11, plan b3d T4): push / delete a tag (delete asks "local only" vs
// "also on <remote>"), delete a remote branch, set an upstream, add a worktree. Views are hook-free;
// containers load what they need and go through the action store.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { RemoteListValue, RpcResult, WorktreeAddValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { actionErrorText } from '../store/action-store.ts'
import sheetCss from './BranchSheets.module.css'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useInitialFocus } from './integrate-parts.tsx'

type Actions = Pick<ActionStore, 'run'>

function failureOf(outcome: ActionOutcome<unknown>): LocalizedText | null {
  return outcome.kind === 'failed' ? outcome.message : outcome.kind === 'conflict' ? actionErrorText(outcome.error) : null
}

/** `origin/feat/x` → `{ remote: 'origin', branch: 'feat/x' }`. */
export function splitRemote(ref: string): { remote: string; branch: string } | null {
  const at = ref.indexOf('/')
  return at <= 0 || at === ref.length - 1 ? null : { remote: ref.slice(0, at), branch: ref.slice(at + 1) }
}

/** Default path of a new worktree: inside the repository, so the sandbox lets git write it. */
export function defaultWorktreePath(branch: string): string {
  return `.worktrees/${branch.replace(/[^\w.-]+/gu, '-')}`
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface FrameProps {
  t: Translate
  busy: boolean
  error: LocalizedText | null
  onCancel: () => void
  rootRef?: Ref<HTMLDivElement>
}

export function TagSheetView(props: FrameProps & {
  mode: 'push' | 'delete'
  name: string
  remotes: readonly string[]
  remote: string
  alsoRemote: boolean
  onRemote: (remote: string) => void
  onAlsoRemote: (on: boolean) => void
  onSubmit: (trigger: FocusTarget | null) => void
}): ReactNode {
  const { t, busy } = props
  const push = props.mode === 'push'
  const canSubmit = !busy && (!push || props.remote !== '')
  const remoteSelect = (
    <select value={props.remote} disabled={busy || props.remotes.length === 0} onChange={event => props.onRemote(event.target.value)} data-tag-remote>
      {props.remotes.map(remote => <option key={remote} value={remote}>{remote}</option>)}
    </select>
  )
  return (
    <SheetFrame dataKind={`tag-${props.mode}`} title={t(push ? 'tag.push.title' : 'tag.delete.title')} subtitle={props.name} label={t(push ? 'tag.push.title' : 'tag.delete.title')} rootRef={props.rootRef} onCancel={() => { if (!busy) props.onCancel() }} onKeyDown={escapeHandler(busy, props.onCancel)}>
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        {push
          ? <label className={sheetCss.field}><span>{t('tag.push.remote')}</span>{remoteSelect}</label>
          : (
              <>
                <p className={sheetCss.warning}>{t('tag.delete.local', { name: props.name })}</p>
                <label className={sheetCss.check}>
                  <input type="checkbox" checked={props.alsoRemote} disabled={busy || props.remotes.length === 0} onChange={event => props.onAlsoRemote(event.target.checked)} data-tag-also-remote />
                  <span>{t('tag.delete.alsoRemote')}</span>
                  {remoteSelect}
                </label>
              </>
            )}
        {props.remotes.length === 0 ? <p className={sheetCss.muted}>{t('remotes.none')}</p> : null}
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t(push ? 'tag.push.submit' : 'tag.delete.submit')} busy={busy} canSubmit={canSubmit} danger={!push} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function RemoteBranchDeleteSheetView(props: FrameProps & { ref_: string; onSubmit: (trigger: FocusTarget | null) => void }): ReactNode {
  const { t, busy } = props
  return (
    <SheetFrame dataKind="remoteBranchDelete" title={t('remoteBranch.delete.title')} subtitle={props.ref_} label={t('remoteBranch.delete.title')} rootRef={props.rootRef} onCancel={() => { if (!busy) props.onCancel() }} onKeyDown={escapeHandler(busy, props.onCancel)}>
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (!busy) props.onSubmit(trigger) })}>
        <p className={sheetCss.warning}>{t('remoteBranch.delete.warning', { ref: props.ref_ })}</p>
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t('remoteBranch.delete.submit')} busy={busy} canSubmit={!busy} danger focusCancel onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function UpstreamSheetView(props: FrameProps & { branch: string; options: readonly string[]; value: string; onValue: (value: string) => void; onSubmit: (trigger: FocusTarget | null) => void }): ReactNode {
  const { t, busy } = props
  const canSubmit = !busy && props.value !== ''
  return (
    <SheetFrame dataKind="upstream" title={t('upstream.title')} subtitle={props.branch} label={t('upstream.title')} rootRef={props.rootRef} onCancel={() => { if (!busy) props.onCancel() }} onKeyDown={escapeHandler(busy, props.onCancel)}>
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <label className={sheetCss.field}>
          <span>{t('upstream.remoteBranch')}</span>
          <select value={props.value} disabled={busy} onChange={event => props.onValue(event.target.value)} data-autofocus="" data-upstream>
            <option value="">{t('upstream.choose')}</option>
            {props.options.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        {props.options.length === 0 ? <p className={sheetCss.muted}>{t('upstream.none')}</p> : null}
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t('upstream.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export function WorktreeAddSheetView(props: FrameProps & {
  branch: string
  createBranch: boolean
  path: string
  lockedBranch: boolean
  onChange: (patch: { branch?: string; createBranch?: boolean; path?: string }) => void
  onSubmit: (trigger: FocusTarget | null) => void
}): ReactNode {
  const { t, busy } = props
  const canSubmit = !busy && props.branch.trim() !== '' && props.path.trim() !== '' && !props.path.startsWith('/') && !props.path.split('/').includes('..')
  return (
    <SheetFrame dataKind="worktreeAdd" title={t('worktree.add.title')} label={t('worktree.add.title')} rootRef={props.rootRef} onCancel={() => { if (!busy) props.onCancel() }} onKeyDown={escapeHandler(busy, props.onCancel)}>
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })}>
        <label className={sheetCss.field}>
          <span>{t('worktree.add.branch')}</span>
          <input value={props.branch} disabled={busy || props.lockedBranch} data-autofocus="" onChange={event => props.onChange({ branch: event.target.value })} data-worktree-branch />
        </label>
        {props.lockedBranch ? null : (
          <label className={sheetCss.check}>
            <input type="checkbox" checked={props.createBranch} disabled={busy} onChange={event => props.onChange({ createBranch: event.target.checked })} />
            <span>{t('worktree.add.createBranch')}</span>
          </label>
        )}
        <label className={sheetCss.field}>
          <span>{t('worktree.add.path')}</span>
          <input value={props.path} disabled={busy} onChange={event => props.onChange({ path: event.target.value })} data-worktree-path />
          <span className={`${sheetCss.muted} ${sheetCss.fieldHint}`}>{t('worktree.add.pathHint')}</span>
        </label>
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t('worktree.add.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function useRemoteNames(load: () => Promise<RpcResult<RemoteListValue>>): string[] {
  const [names, setNames] = useState<string[]>([])
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let alive = true
    void loadRef.current().then((result) => { if (alive && result.ok) setNames(result.value.remotes.map(remote => remote.name)) })
    return () => { alive = false }
  }, [])
  return names
}

/** A finished sheet write; `success` is the sentence for the workbench notice (T1). */
export type SheetOutcome = (outcome: ActionOutcome<unknown>, success?: LocalizedText) => void

function useSubmit(onOutcome: SheetOutcome, onClose: () => void): { busy: boolean; error: LocalizedText | null; send: (task: () => Promise<ActionOutcome<unknown>>, success?: LocalizedText) => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  return {
    busy,
    error,
    send: async (task, success) => {
      setBusy(true)
      setError(null)
      const outcome = await task()
      setBusy(false)
      const failure = failureOf(outcome)
      if (failure !== null) {
        setError(failure)
        return
      }
      if (outcome.kind === 'done') {
        onOutcome(outcome, success)
        onClose()
      }
    },
  }
}

export function TagSheet(props: { mode: 'push' | 'delete'; name: string; loadRemotes: () => Promise<RpcResult<RemoteListValue>>; actions: Actions; onOutcome: SheetOutcome; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const remotes = useRemoteNames(props.loadRemotes)
  const [remote, setRemote] = useState('')
  const [alsoRemote, setAlsoRemote] = useState(false)
  const chosen = remote !== '' ? remote : (remotes.includes('origin') ? 'origin' : remotes[0] ?? '')
  const { busy, error, send } = useSubmit(props.onOutcome, props.onClose)
  return (
    <TagSheetView
      t={t} mode={props.mode} name={props.name} remotes={remotes} remote={chosen} alsoRemote={alsoRemote}
      busy={busy} error={error} rootRef={rootRef} onCancel={props.onClose}
      onRemote={setRemote} onAlsoRemote={setAlsoRemote}
      onSubmit={(trigger) => {
        void send(() => (props.mode === 'push'
          ? props.actions.run('tagPush', { name: props.name, remote: chosen }, { target: `tag:${props.name}`, trigger })
          : props.actions.run('tagDelete', { name: props.name, ...(alsoRemote && chosen !== '' ? { remote: chosen } : {}) }, { target: `tag:${props.name}`, trigger })),
        props.mode === 'push' ? text('tag.push.done', { name: props.name, remote: chosen }) : undefined)
      }}
    />
  )
}

export function RemoteBranchDeleteSheet(props: { ref_: string; actions: Actions; onOutcome: SheetOutcome; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const { busy, error, send } = useSubmit(props.onOutcome, props.onClose)
  const split = splitRemote(props.ref_)
  return (
    <RemoteBranchDeleteSheetView
      t={t} ref_={props.ref_} busy={busy} error={error} rootRef={rootRef} onCancel={props.onClose}
      onSubmit={(trigger) => {
        if (split === null) return
        void send(() => props.actions.run('remoteBranchDelete', split, { target: `remote-branch:${props.ref_}`, trigger }), text('remoteBranch.delete.done', { ref: props.ref_ }))
      }}
    />
  )
}

export function UpstreamSheet(props: { branch: string; upstream?: string | undefined; remoteBranches: readonly string[]; actions: Actions; onOutcome: SheetOutcome; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const options = props.remoteBranches.filter(name => !name.endsWith('/HEAD'))
  const [value, setValue] = useState(props.upstream ?? (options.find(name => splitRemote(name)?.branch === props.branch) ?? ''))
  const { busy, error, send } = useSubmit(props.onOutcome, props.onClose)
  return (
    <UpstreamSheetView
      t={t} branch={props.branch} options={options} value={value} busy={busy} error={error} rootRef={rootRef} onCancel={props.onClose}
      onValue={setValue}
      onSubmit={(trigger) => {
        void send(() => props.actions.run('setUpstream', { branch: props.branch, upstream: value }, { target: `upstream:${props.branch}`, trigger }), text('upstream.set.done', { branch: props.branch, upstream: value }))
      }}
    />
  )
}

export function WorktreeAddSheet(props: { branch?: string | undefined; actions: Actions; onAdded: (value: WorktreeAddValue) => void; onClose: () => void }): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const [form, setForm] = useState({ branch: props.branch ?? '', createBranch: props.branch === undefined, path: props.branch === undefined ? '' : defaultWorktreePath(props.branch) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)
  return (
    <WorktreeAddSheetView
      t={t} branch={form.branch} createBranch={form.createBranch} path={form.path} lockedBranch={props.branch !== undefined}
      busy={busy} error={error} rootRef={rootRef} onCancel={props.onClose}
      onChange={(patch) => {
        setForm((current) => {
          const next = { ...current, ...patch }
          // Keep the default path following the branch until the user edits the path.
          if (patch.branch !== undefined && current.path === defaultWorktreePath(current.branch)) next.path = defaultWorktreePath(patch.branch)
          if (patch.branch !== undefined && current.path === '') next.path = defaultWorktreePath(patch.branch)
          return next
        })
        setError(null)
      }}
      onSubmit={(trigger) => {
        void (async () => {
          setBusy(true)
          const outcome = await props.actions.run('worktreeAdd', { path: form.path.trim(), branch: form.branch.trim(), createBranch: form.createBranch }, { target: 'worktree-add', trigger })
          setBusy(false)
          if (outcome.kind === 'done') {
            props.onAdded(outcome.value)
            props.onClose()
          } else {
            setError(failureOf(outcome))
          }
        })()
      }}
    />
  )
}
