// Push overlay (design §11): remote, remote branch (explicit for detached HEAD), set upstream,
// push tags, --force-with-lease behind a risk tick, and the commits to push. A rejection
// switches the same overlay to the Push Rejected view; Esc goes back one level (§5.3) and
// focus returns to the trigger on close. State lives in push-store; views here have no hooks.
import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { GitError, PushRejectedDetails, PushValue } from '../../shared/protocol.ts'
import {
  browserStorage,
  createPushStore,
  pushEscapeAction,
  pushSubmitBlock,
  rememberFocus,
  usePushState,
} from '../store/push-store.ts'
import type {
  KeyValueStorage,
  PushBlockReason,
  PushClient,
  PushForm,
  PushOutcome,
  PushState,
  PushStore,
} from '../store/push-store.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { CommitList, PushOverlayFrame, PushRejectedView, submitHandler, WriteErrorNotice } from './PushRejectedPage.tsx'
import css from './PushPage.module.css'

/** Every visible string of this file (moved into locales by T7). */

/** Write to the clipboard; silently skipped without navigator (SSR / unit tests). */
function copyToClipboard(text: string): void {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

export function pushBlockText(t: Translate, reason: PushBlockReason | null, readOnlyReason: string | null): string | null {
  if (readOnlyReason !== null) return t('write.readOnly', { reason: readOnlyReason })
  if (reason === null || reason === 'loading' || reason === 'busy') return null
  return t(`push.block.${reason}`)
}

// ---------------------------------------------------------------------------
// Push view (no hooks)
// ---------------------------------------------------------------------------

export interface PushPageViewProps {
  t: Translate
  state: PushState
  readOnlyReason: string | null
  rootRef?: Ref<HTMLDivElement>
  onClose: () => void
  onRetryLoad: () => void
  onFormChange: (patch: Partial<PushForm>) => void
  onSubmit: () => void
  onCopy: (text: string) => void
  onShowConsole?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function PushPageView({
  t,
  state,
  readOnlyReason,
  rootRef,
  onClose,
  onRetryLoad,
  onFormChange,
  onSubmit,
  onCopy,
  onShowConsole,
  onKeyDown,
}: PushPageViewProps): ReactNode {
  const { form, preview } = state
  const busy = state.busy !== null
  const local = preview === null ? '' : preview.detached || preview.branch === null ? t('push.detachedLocal') : preview.branch
  const target = preview === null
    ? undefined
    : t('push.target', { local, remote: form.remote || '?', branch: form.branch.trim() || '?' })

  let body: ReactNode
  if (state.previewStatus === 'error') {
    body = (
      <div className={css.state}>
        <EmptyState error title={t('push.loadFailed')} hint={state.previewError?.message} action={{ label: t('action.retry'), onClick: onRetryLoad }} />
      </div>
    )
  } else if (preview === null) {
    body = <p className={css.loading} role="status">{t('push.loading')}</p>
  } else if (preview.remotes.length === 0) {
    body = (
      <div className={css.state}>
        <EmptyState title={t('push.noRemotes')} hint={t('push.noRemotesHint')} />
      </div>
    )
  } else {
    const block = pushSubmitBlock(state)
    const disabled = readOnlyReason !== null || block !== null
    const blockText = pushBlockText(t, block, readOnlyReason)
    const submitLabel = busy ? t('push.submitting') : form.forceWithLease ? t('push.submitForce') : t('push.submit')
    body = (
      <form className={css.body} onSubmit={submitHandler(() => { if (!disabled) onSubmit() })} data-push-form>
        <fieldset className={css.fields} disabled={busy}>
          <label className={css.field}>
            <span className={css.label}>{t('push.remote')}</span>
            <select
              className={css.control}
              value={form.remote}
              onChange={event => onFormChange({ remote: event.currentTarget.value })}
              data-field="remote"
            >
              {preview.remotes.map(remote => <option key={remote} value={remote}>{remote}</option>)}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.label}>{t('push.branch')}</span>
            <input
              className={css.control}
              type="text"
              value={form.branch}
              placeholder={t('push.branchPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={block === 'detached-branch' || block === 'no-branch' ? true : undefined}
              onChange={event => onFormChange({ branch: event.currentTarget.value })}
              data-field="branch"
            />
          </label>
          {preview.detached ? <p className={css.hint} data-detached-hint>{t('push.detachedHint')}</p> : null}
          <label className={css.check}>
            <input type="checkbox" checked={form.setUpstream} onChange={event => onFormChange({ setUpstream: event.currentTarget.checked })} data-field="setUpstream" />
            <span>{t('push.setUpstream')}</span>
          </label>
          <label className={css.check}>
            <input type="checkbox" checked={form.tags} onChange={event => onFormChange({ tags: event.currentTarget.checked })} data-field="tags" />
            <span>{t('push.tags')}</span>
          </label>
          <label className={css.check}>
            <input type="checkbox" checked={form.forceWithLease} onChange={event => onFormChange({ forceWithLease: event.currentTarget.checked })} data-field="forceWithLease" />
            <span>{t('push.force')}</span>
          </label>
          {form.forceWithLease ? (
            <div className={css.danger} data-force-risk>
              <p className={css.dangerText}>{t('push.forceImpact', { remote: form.remote, branch: form.branch.trim() || '?' })}</p>
              <label className={css.check}>
                <input type="checkbox" checked={form.riskConfirmed} onChange={event => onFormChange({ riskConfirmed: event.currentTarget.checked })} data-field="riskConfirmed" />
                <span>{t('push.forceRisk')}</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{t('push.commits', { count: preview.commits.length })}</h3>
          {preview.commits.length === 0
            ? <p className={css.hint}>{t('push.noCommits')}</p>
            : <CommitList t={t} commits={preview.commits} truncated={preview.truncated} label={t('push.commits', { count: preview.commits.length })} />}
        </section>

        {state.error === null ? null : <WriteErrorNotice t={t} error={state.error} onCopy={onCopy} onShowConsole={onShowConsole} />}

        <footer className={css.footer}>
          {blockText === null ? <span /> : <span className={css.blockReason} data-block-reason>{blockText}</span>}
          <span className={css.actions}>
            <Button disabled={busy} onClick={onClose}>{t('action.cancel')}</Button>
            <Button
              type="submit"
              tone={form.forceWithLease ? 'danger' : 'primary'}
              disabled={disabled}
              aria-busy={busy ? true : undefined}
              data-primary
            >
              {submitLabel}
            </Button>
          </span>
        </footer>
      </form>
    )
  }

  return (
    <PushOverlayFrame
      t={t}
      title={t('push.title')}
      {...(target === undefined ? {} : { subtitle: target })}
      label={t('push.dialogLabel', { target: target ?? '' })}
      busy={busy}
      rootRef={rootRef}
      onBack={onClose}
      onKeyDown={onKeyDown}
    >
      {body}
    </PushOverlayFrame>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface PushPageProps {
  sessionId: string
  /** Key for remembering the last remote/branch. */
  repoRoot: string
  /** Subset of GitClient: `pushPreview`, `push`, `pullForPush`. */
  client: PushClient
  /** Defaults to window.localStorage (all access guarded). */
  storage?: KeyValueStorage | null
  /** Non-null disables the write actions and shows the reason. */
  readOnlyReason?: string | null
  /** Open directly on Push Rejected (e.g. "commit and push" got `git/rejected`); Esc then closes. */
  initialRejection?: PushRejectedDetails
  /** Leave the overlay; the caller unmounts it and returns focus to the trigger. */
  onClose: () => void
  /** Push succeeded (also after the automatic retry); `onClose` follows. */
  onPushed: (value: PushValue) => void
  /** `pullForPush` stopped on conflicts: show the operation banner / console; `onClose` follows. */
  onConflict: (error: GitError) => void
  onShowConsole?: () => void
  onCopy?: (text: string) => void
  newRequestId?: () => string
  /** Inject a prepared store (tests). */
  store?: PushStore
}

/** Apply the side effects of a finished action: success / conflict leave the overlay. */
export function handlePushOutcome(
  outcome: PushOutcome,
  callbacks: Pick<PushPageProps, 'onClose' | 'onPushed' | 'onConflict'>,
): void {
  if (outcome.kind === 'pushed') {
    callbacks.onPushed(outcome.value)
    callbacks.onClose()
  } else if (outcome.kind === 'conflict') {
    callbacks.onConflict(outcome.error)
    callbacks.onClose()
  }
}

/** Esc dispatcher shared by both views: back one level, close, or ignore while busy. */
export function handlePushEscape(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>,
  state: PushState,
  actions: { back: () => void; close: () => void },
): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  const action = pushEscapeAction(state)
  if (action === 'back') actions.back()
  else if (action === 'close') actions.close()
}

/**
 * Push / Push Rejected overlay. Place it inside the Git tab's `position: relative` content area;
 * render at most one overlay at a time (§5.3).
 */
export function PushPage(props: PushPageProps): ReactNode {
  const { sessionId, repoRoot, initialRejection } = props
  const propsRef = useRef(props)
  propsRef.current = props
  const store = useMemo(
    () => props.store ?? createPushStore({
      client: {
        pushPreview: (...args) => propsRef.current.client.pushPreview(...args),
        push: (...args) => propsRef.current.client.push(...args),
        pullForPush: (...args) => propsRef.current.client.pullForPush(...args),
      },
      sessionId,
      repoRoot,
      storage: props.storage === undefined ? browserStorage() : props.storage,
      ...(props.newRequestId === undefined ? {} : { newRequestId: props.newRequestId }),
      ...(initialRejection === undefined ? {} : { initialRejection }),
    }),
    // A new session/repository is a new overlay; other prop changes go through propsRef.
    [sessionId, repoRoot],
  )
  const state = usePushState(store)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const restoreFocus = rememberFocus()
    rootRef.current?.focus()
    if (store.getState().view === 'push') void store.load()
    return () => {
      mounted.current = false
      store.dispose()
      restoreFocus()
    }
  }, [store])

  // Switching between the push and rejected views remounts the frame; keep focus inside.
  useEffect(() => { rootRef.current?.focus() }, [state.view])

  const close = (): void => { if (mounted.current) propsRef.current.onClose() }
  const finish = (outcome: PushOutcome): void => {
    handlePushOutcome(outcome, {
      onPushed: value => propsRef.current.onPushed(value),
      onConflict: error => propsRef.current.onConflict(error),
      onClose: close,
    })
  }
  const back = (): void => {
    store.backToPush()
    if (store.getState().previewStatus === 'idle') void store.load()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    handlePushEscape(event, store.getState(), { back, close })
  }
  const t = useT()
  const readOnlyReason = props.readOnlyReason ?? null
  const onCopy = props.onCopy ?? copyToClipboard

  if (state.view === 'rejected') {
    return (
      <PushRejectedView
        t={t}
        state={state}
        readOnlyReason={readOnlyReason}
        rootRef={rootRef}
        onBack={() => { if (pushEscapeAction(state) === 'back') back(); else close() }}
        onCancel={close}
        onChoice={choice => store.setChoice(choice)}
        onRiskChange={confirmed => store.setChoiceRiskConfirmed(confirmed)}
        onSubmit={() => { void store.resolveRejected().then(finish) }}
        onCopy={onCopy}
        {...(props.onShowConsole === undefined ? {} : { onShowConsole: props.onShowConsole })}
        onKeyDown={onKeyDown}
      />
    )
  }
  return (
    <PushPageView
      t={t}
      state={state}
      readOnlyReason={readOnlyReason}
      rootRef={rootRef}
      onClose={close}
      onRetryLoad={() => { void store.load() }}
      onFormChange={patch => store.updateForm(patch)}
      onSubmit={() => { void store.submit().then(finish) }}
      onCopy={onCopy}
      {...(props.onShowConsole === undefined ? {} : { onShowConsole: props.onShowConsole })}
      onKeyDown={onKeyDown}
    />
  )
}
