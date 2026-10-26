// Push Rejected overlay (design §11): reason, the remote's new commits and the handling choice
// (pull + rebase by default / pull + merge / force-with-lease behind a risk tick, never for
// protected branches). Also hosts the overlay frame, commit list and write-error notice shared
// with PushPage and RollbackSheet (kept here so PushPage → PushRejectedPage stays acyclic).
import type { FormEvent, KeyboardEvent, ReactNode, Ref } from 'react'
import type { CommitSummary, GitError, GitErrorCode, PushRejectReason } from '../../shared/protocol.ts'
import { authCommandOf, formatText, rejectChoicesFor, rejectedSubmitBlock } from '../store/push-store.ts'
import type { PushState, RejectChoice, RejectedBlockReason } from '../store/push-store.ts'
import { Button } from '../ui/Button.tsx'
import css from './PushRejectedPage.module.css'

/** Every visible string of this file (moved into locales by T7). */
export const TEXT = {
  back: '← 返回',
  backTitle: '返回（Esc）',
  title: '推送被拒绝',
  target: '{remote}/{branch}',
  reason: {
    'non-fast-forward': '推送被拒绝。远程分支有你本地没有的提交。先拉取并变基，再推送。',
    'fetch-first': '推送被拒绝。远程已有你本地还没获取的提交。先拉取，再推送。',
    'stale-lease': '强制推送被拒绝。远程分支在你上次获取后又被更新，--force-with-lease 阻止了覆盖。先拉取并确认远程改动。',
    protected: '推送被拒绝。远程分支受保护，不允许直接推送或强制推送。',
    'hook-declined': '推送被远程 hook 拒绝。查看 Git 控制台了解原因。',
    other: '推送被拒绝。',
  },
  dialogLabel: '推送被拒绝：{target}',
  summaryLabel: 'Git 输出：',
  remoteCommits: '远程新提交（{count}）',
  noRemoteCommits: '没有读取到远程新提交',
  choiceLegend: '处理方式',
  choice: {
    rebase: '拉取并变基（推荐）',
    merge: '拉取并合并',
    force: '强制推送（--force-with-lease）',
  },
  choiceHint: {
    rebase: '把本地提交放到远程新提交之后，历史保持线性；成功后自动重试推送一次。',
    merge: '生成一个合并提交；成功后自动重试推送一次。',
    force: '用本地分支覆盖远程分支；远程在你上次获取后又被更新时 Git 会拒绝。',
  },
  protectedNoForce: '受保护分支不提供强制推送。',
  forceImpact: '将用本地分支覆盖 {remote}/{branch}，远程上的 {count} 个提交会从该分支上消失。',
  forceRisk: '我了解强制推送会覆盖远程上他人的提交',
  autoRetryRejected: '已拉取，但自动重试推送仍被拒绝。请重新选择处理方式。',
  submitPull: '拉取并重试推送',
  submitForce: '强制推送',
  busy: {
    push: '正在推送…',
    pull: '正在拉取…',
    retry: '正在重试推送…',
  },
  cancel: '取消',
  block: {
    busy: '',
    'risk-unconfirmed': '勾选风险确认后才能强制推送',
    'force-protected': '受保护分支不能强制推送',
  },
  readOnly: '只读模式：{reason}',
  showConsole: '查看 Git 控制台',
  copyCommand: '复制命令',
  errorTitle: {
    'git/auth-required': '需要认证。Git 不能在面板内输入凭据，请在终端运行下面的命令完成认证后重试。',
    'git/locked': '仓库被锁定：另一个 Git 进程正在运行。稍后重试。',
    'git/hook-failed': '被 Git hook 阻止。查看 Git 控制台了解原因。',
    'git/sandbox-denied': '沙箱不允许这个写操作。',
    'git/timeout': '操作超时。',
    'git/operation-in-progress': '仓库正处于合并/变基等操作中，先完成或放弃该操作。',
    fallback: '操作失败。',
  },
  commitsTruncated: '仅显示前 {count} 个提交',
} as const

// ---------------------------------------------------------------------------
// Shared overlay pieces
// ---------------------------------------------------------------------------

export interface PushOverlayFrameProps {
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
export function PushOverlayFrame({ title, subtitle, label, busy = false, rootRef, onBack, onKeyDown, children }: PushOverlayFrameProps): ReactNode {
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
        <Button className={css.back} title={TEXT.backTitle} disabled={busy} onClick={onBack}>{TEXT.back}</Button>
        <strong className={css.title}>{title}</strong>
        {subtitle === undefined ? null : <span className={css.subtitle} title={subtitle}>{subtitle}</span>}
      </header>
      {children}
    </div>
  )
}

export interface CommitListProps {
  commits: readonly CommitSummary[]
  truncated?: boolean
  label: string
}

export function CommitList({ commits, truncated = false, label }: CommitListProps): ReactNode {
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
      {truncated ? <p className={css.muted}>{formatText(TEXT.commitsTruncated, { count: commits.length })}</p> : null}
    </>
  )
}

type ErrorTitleKey = keyof typeof TEXT.errorTitle

function errorTitle(code: GitErrorCode): string {
  return code in TEXT.errorTitle ? TEXT.errorTitle[code as ErrorTitleKey] : TEXT.errorTitle.fallback
}

export interface WriteErrorNoticeProps {
  error: GitError
  onCopy: (text: string) => void
  onShowConsole?: () => void
}

/** Actionable error (what happened + next step); `git/auth-required` shows a copyable command. */
export function WriteErrorNotice({ error, onCopy, onShowConsole }: WriteErrorNoticeProps): ReactNode {
  const command = authCommandOf(error)
  return (
    <div className={css.error} role="alert" data-error-code={error.code}>
      <strong>{errorTitle(error.code)}</strong>
      {error.message === '' ? null : <span className={css.errorDetail}>{error.message}</span>}
      {command === null ? null : (
        <span className={css.command}>
          <code className={css.commandText} data-auth-command>{command}</code>
          <Button title={TEXT.copyCommand} onClick={() => onCopy(command)}>{TEXT.copyCommand}</Button>
        </span>
      )}
      {onShowConsole === undefined ? null : (
        <span><Button onClick={onShowConsole}>{TEXT.showConsole}</Button></span>
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

export function rejectReasonText(reason: PushRejectReason): string {
  return TEXT.reason[reason]
}

export function rejectedBlockText(reason: RejectedBlockReason | null, readOnlyReason: string | null): string | null {
  if (readOnlyReason !== null) return formatText(TEXT.readOnly, { reason: readOnlyReason })
  if (reason === null || reason === 'busy') return null
  return TEXT.block[reason]
}

export interface PushRejectedViewProps {
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
  const blockText = rejectedBlockText(block, readOnlyReason)
  const target = formatText(TEXT.target, { remote: rejected.remote, branch: rejected.branch })
  const force = state.choice === 'force'
  const submitLabel = state.busy === null ? (force ? TEXT.submitForce : TEXT.submitPull) : TEXT.busy[state.busy]

  return (
    <PushOverlayFrame
      title={TEXT.title}
      subtitle={target}
      label={formatText(TEXT.dialogLabel, { target })}
      busy={busy}
      rootRef={rootRef}
      onBack={onBack}
      onKeyDown={onKeyDown}
    >
      <form className={css.body} onSubmit={submitHandler(() => { if (!disabled) onSubmit() })} data-push-rejected={rejected.reason}>
        <p className={css.reason} role="status" data-reason={rejected.reason}>{rejectReasonText(rejected.reason)}</p>
        {state.autoRetryRejected ? <p className={css.warning} data-auto-retry-rejected>{TEXT.autoRetryRejected}</p> : null}
        {rejected.summary === '' ? null : (
          <p className={css.muted}>
            {TEXT.summaryLabel}<code className={css.inlineCode}>{rejected.summary}</code>
          </p>
        )}

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{formatText(TEXT.remoteCommits, { count: rejected.remoteCommits.length })}</h3>
          {rejected.remoteCommits.length === 0
            ? <p className={css.muted}>{TEXT.noRemoteCommits}</p>
            : <CommitList commits={rejected.remoteCommits} label={formatText(TEXT.remoteCommits, { count: rejected.remoteCommits.length })} />}
        </section>

        <fieldset className={css.section} disabled={busy}>
          <legend className={css.sectionTitle}>{TEXT.choiceLegend}</legend>
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
                <span>{TEXT.choice[choice]}</span>
                <span className={css.muted}>{TEXT.choiceHint[choice]}</span>
              </span>
            </label>
          ))}
          {rejected.reason === 'protected' ? <p className={css.muted} data-protected-note>{TEXT.protectedNoForce}</p> : null}
          {force ? (
            <div className={css.danger} data-force-risk>
              <p className={css.dangerText}>
                {formatText(TEXT.forceImpact, { remote: rejected.remote, branch: rejected.branch, count: rejected.remoteCommits.length })}
              </p>
              <label className={css.check}>
                <input type="checkbox" checked={state.choiceRiskConfirmed} onChange={event => onRiskChange(event.currentTarget.checked)} />
                <span>{TEXT.forceRisk}</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        {state.error === null ? null : <WriteErrorNotice error={state.error} onCopy={onCopy} onShowConsole={onShowConsole} />}

        <footer className={css.footer}>
          {blockText === null ? <span /> : <span className={css.blockReason} data-block-reason>{blockText}</span>}
          <span className={css.actions}>
            <Button disabled={busy} onClick={onCancel}>{TEXT.cancel}</Button>
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
