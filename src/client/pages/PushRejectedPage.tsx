// Push Rejected overlay (design §11): reason, the remote's new commits and the handling choice
// (pull + rebase by default / pull + merge / force-with-lease behind a risk tick, never for
// protected branches). Also hosts the overlay frame, commit list and write-error notice shared
// with PushPage and RollbackSheet (kept here so PushPage → PushRejectedPage stays acyclic).
import type { FormEvent, KeyboardEvent, ReactNode, Ref } from 'react'
import type { CommitSummary, GitError, GitErrorCode, PushRejectReason } from '../../shared/protocol.ts'
import type { Translate } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import { authCommandOf, rejectChoicesFor, rejectedSubmitBlock } from '../store/push-store.ts'
import type { PushState, RejectChoice, RejectedBlockReason } from '../store/push-store.ts'
import { Button } from '../ui/Button.tsx'
import css from './PushRejectedPage.module.css'

/** Every visible string of this file (moved into locales by T7). */

// ---------------------------------------------------------------------------
// Shared overlay pieces
// ---------------------------------------------------------------------------

export interface PushOverlayFrameProps {
  t: Translate
  title: string
  subtitle?: string
  /** Accessible name of the dialog. */
  label: string
  busy?: boolean
  rootRef?: Ref<HTMLDivElement>
  onBack: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/** Full-height overlay frame (§11): `← 返回` header, scrolling body supplied by children. */
export function PushOverlayFrame({ t, title, subtitle, label, busy = false, rootRef, onBack, onKeyDown, children }: PushOverlayFrameProps): ReactNode {
  return (
    <div
      ref={rootRef}
      className={css.root}
      role="dialog"
      aria-label={label}
      aria-busy={busy ? true : undefined}
      tabIndex={-1}
      data-push-overlay
      onKeyDown={onKeyDown}
    >
      <header className={css.header}>
        <Button className={css.back} title={t('diff.back.title')} disabled={busy} onClick={onBack}>{t('diff.back')}</Button>
        <strong className={css.title}>{title}</strong>
        {subtitle === undefined ? null : <span className={css.subtitle} title={subtitle}>{subtitle}</span>}
      </header>
      {children}
    </div>
  )
}

export interface CommitListProps {
  t: Translate
  commits: readonly CommitSummary[]
  truncated?: boolean
  label: string
}

export function CommitList({ t, commits, truncated = false, label }: CommitListProps): ReactNode {
  return (
    <>
      <ul className={css.commits} aria-label={label}>
        {commits.map(commit => (
          <li key={commit.sha} className={css.commit} data-commit={commit.sha}>
            <code className={css.sha} title={commit.sha}>{commit.shortSha}</code>
            <span className={css.subject} title={commit.subject}>{commit.subject}</span>
            <span className={css.author}>{commit.author}</span>
          </li>
        ))}
      </ul>
      {truncated ? <p className={css.muted}>{t('rejected.commitsTruncated', { count: commits.length })}</p> : null}
    </>
  )
}

const ERROR_TITLE: Partial<Record<GitErrorCode, GitWorkbenchKey>> = {
  'git/auth-required': 'write.error.git/auth-required',
  'git/locked': 'write.error.git/locked',
  'git/hook-failed': 'write.error.git/hook-failed',
  'git/sandbox-denied': 'write.error.git/sandbox-denied',
  'git/timeout': 'write.error.git/timeout',
  'git/operation-in-progress': 'write.error.git/operation-in-progress',
}

/** Localized title for a failed write; codes without a dedicated text use the generic one. */
export function writeErrorTitle(t: Translate, code: GitErrorCode): string {
  return t(ERROR_TITLE[code] ?? 'write.error.fallback')
}

export interface WriteErrorNoticeProps {
  t: Translate
  error: GitError
  onCopy: (text: string) => void
  onShowConsole?: () => void
}

/** Actionable error (what happened + next step); `git/auth-required` shows a copyable command. */
export function WriteErrorNotice({ t, error, onCopy, onShowConsole }: WriteErrorNoticeProps): ReactNode {
  const command = authCommandOf(error)
  return (
    <div className={css.error} role="alert" data-error-code={error.code}>
      <strong>{writeErrorTitle(t, error.code)}</strong>
      {error.message === '' ? null : <span className={css.errorDetail}>{error.message}</span>}
      {command === null ? null : (
        <span className={css.command}>
          <code className={css.commandText} data-auth-command>{command}</code>
          <Button title={t('console.copyCommand')} onClick={() => onCopy(command)}>{t('console.copyCommand')}</Button>
        </span>
      )}
      {onShowConsole === undefined ? null : (
        <span><Button onClick={onShowConsole}>{t('write.showConsole')}</Button></span>
      )}
    </div>
  )
}

/** Run a form submit without a page navigation (Enter triggers the primary action). */
export function submitHandler(action: () => void): (event: FormEvent) => void {
  return (event) => {
    event.preventDefault()
    action()
  }
}

// ---------------------------------------------------------------------------
// Push Rejected view (no hooks)
// ---------------------------------------------------------------------------

export function rejectReasonText(t: Translate, reason: PushRejectReason): string {
  return t(`rejected.reason.${reason}`)
}

export function rejectedBlockText(t: Translate, reason: RejectedBlockReason | null, readOnlyReason: string | null): string | null {
  if (readOnlyReason !== null) return t('write.readOnly', { reason: readOnlyReason })
  if (reason === null || reason === 'busy') return null
  return t(`rejected.block.${reason}`)
}

export interface PushRejectedViewProps {
  t: Translate
  state: PushState
  /** Non-null when writes are disabled; shown as the reason. */
  readOnlyReason: string | null
  rootRef?: Ref<HTMLDivElement>
  onBack: () => void
  onCancel: () => void
  onChoice: (choice: RejectChoice) => void
  onRiskChange: (confirmed: boolean) => void
  onSubmit: () => void
  onCopy: (text: string) => void
  onShowConsole?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function PushRejectedView({
  t,
  state,
  readOnlyReason,
  rootRef,
  onBack,
  onCancel,
  onChoice,
  onRiskChange,
  onSubmit,
  onCopy,
  onShowConsole,
  onKeyDown,
}: PushRejectedViewProps): ReactNode {
  const rejected = state.rejected
  if (rejected === null) return null
  const busy = state.busy !== null
  const choices = rejectChoicesFor(rejected.reason)
  const block = rejectedSubmitBlock(state)
  const disabled = readOnlyReason !== null || block !== null
  const blockText = rejectedBlockText(t, block, readOnlyReason)
  const target = t('rejected.target', { remote: rejected.remote, branch: rejected.branch })
  const force = state.choice === 'force'
  const submitLabel = state.busy === null ? (force ? t('push.submitForce') : t('rejected.submitPull')) : t(`rejected.busy.${state.busy}`)

  return (
    <PushOverlayFrame
      t={t}
      title={t('rejected.title')}
      subtitle={target}
      label={t('rejected.dialogLabel', { target })}
      busy={busy}
      rootRef={rootRef}
      onBack={onBack}
      onKeyDown={onKeyDown}
    >
      <form className={css.body} onSubmit={submitHandler(() => { if (!disabled) onSubmit() })} data-push-rejected={rejected.reason}>
        <p className={css.reason} role="status" data-reason={rejected.reason}>{rejectReasonText(t, rejected.reason)}</p>
        {state.autoRetryRejected ? <p className={css.warning} data-auto-retry-rejected>{t('rejected.autoRetryRejected')}</p> : null}
        {rejected.summary === '' ? null : (
          <p className={css.muted}>
            {t('rejected.summaryLabel')}<code className={css.inlineCode}>{rejected.summary}</code>
          </p>
        )}

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{t('rejected.remoteCommits', { count: rejected.remoteCommits.length })}</h3>
          {rejected.remoteCommits.length === 0
            ? <p className={css.muted}>{t('rejected.noRemoteCommits')}</p>
            : <CommitList t={t} commits={rejected.remoteCommits} label={t('rejected.remoteCommits', { count: rejected.remoteCommits.length })} />}
        </section>

        <fieldset className={css.section} disabled={busy}>
          <legend className={css.sectionTitle}>{t('rejected.choiceLegend')}</legend>
          {choices.map(choice => (
            <label key={choice} className={css.choice} data-choice={choice}>
              <input
                type="radio"
                name="push-rejected-choice"
                value={choice}
                checked={state.choice === choice}
                onChange={() => onChoice(choice)}
              />
              <span className={css.choiceText}>
                <span>{t(`rejected.choice.${choice}`)}</span>
                <span className={css.muted}>{t(`rejected.choiceHint.${choice}`)}</span>
              </span>
            </label>
          ))}
          {rejected.reason === 'protected' ? <p className={css.muted} data-protected-note>{t('rejected.protectedNoForce')}</p> : null}
          {force ? (
            <div className={css.danger} data-force-risk>
              <p className={css.dangerText}>
                {t('rejected.forceImpact', { remote: rejected.remote, branch: rejected.branch, count: rejected.remoteCommits.length })}
              </p>
              <label className={css.check}>
                <input type="checkbox" checked={state.choiceRiskConfirmed} onChange={event => onRiskChange(event.currentTarget.checked)} />
                <span>{t('push.forceRisk')}</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        {state.error === null ? null : <WriteErrorNotice t={t} error={state.error} onCopy={onCopy} onShowConsole={onShowConsole} />}

        <footer className={css.footer}>
          {blockText === null ? <span /> : <span className={css.blockReason} data-block-reason>{blockText}</span>}
          <span className={css.actions}>
            <Button disabled={busy} onClick={onCancel}>{t('action.cancel')}</Button>
            <Button
              type="submit"
              tone={force ? 'danger' : 'primary'}
              disabled={disabled}
              aria-busy={busy ? true : undefined}
              data-primary
            >
              {submitLabel}
            </Button>
          </span>
        </footer>
      </form>
    </PushOverlayFrame>
  )
}
