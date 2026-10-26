// 操作状态横幅（设计 §7.3）：仓库处于 merge/rebase/cherry-pick/revert/bisect 中时提示类型、目标分支、
// 冲突数与变基进度。A3 T9 起提供「解决冲突…」「继续」「跳过」（仅变基/拣选）「中止…」（二次确认）。
// 没有传动作回调时（只读视图）仍只显示「查看控制台」与终端提示。
import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { OperationStep, RepoOperation, StatusValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import { SKIPPABLE } from '../operations.ts'
import type { Translate } from '../i18n.tsx'
import { OPERATION_KEY } from '../locales.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import css from './OperationBanner.module.css'

/** 横幅展示的进行中操作（协议 RepoOperation 去掉 null；bisect 已由 Host 返回）。 */
export type BannerOperation = Exclude<RepoOperation, null>

/** Display-name keys of the in-progress operations (shared with the status bar). */
export const OPERATION_LABEL: Record<BannerOperation, GitWorkbenchKey> = OPERATION_KEY

/** Operations the Host can skip a commit of; shared with the action store's error texts. */
export { SKIPPABLE }

/** Write handlers of the banner; each gets the clicked button (async overlays return focus to it). */
export interface OperationBannerActions {
  onResolve?: ((trigger: FocusTarget | null) => void) | undefined
  onContinue?: ((trigger: FocusTarget | null) => void) | undefined
  onSkip?: ((trigger: FocusTarget | null) => void) | undefined
  /** Called after the user confirmed the abort. */
  onAbort?: ((trigger: FocusTarget | null) => void) | undefined
}

export interface OperationBannerProps extends OperationBannerActions {
  operation: BannerOperation | null
  conflicts: number
  /** 当前（目标）分支；detached 时为 null。 */
  branch?: string | null
  /** Rebase progress (`2/5`). */
  step?: OperationStep | null
  /** A smart stash waits for the end of the operation. */
  pendingStash?: boolean
  /** An operation control is running: write buttons wait. */
  busy?: boolean
  /** Why writes are disabled (read-only repository); null when allowed. */
  blockReason?: string | null
  onOpenConsole?: () => void
}

/** 从 StatusValue 推导横幅 props。 */
export function bannerFromStatus(status: StatusValue | null): Pick<OperationBannerProps, 'operation' | 'conflicts'> & { branch: string | null; step: OperationStep | null } {
  if (status === null) return { operation: null, conflicts: 0, branch: null, step: null }
  return { operation: status.operation, conflicts: status.conflicts.length, branch: status.branch, step: status.operationStep ?? null }
}

export interface OperationBannerViewProps extends OperationBannerProps {
  t: Translate
  confirmingAbort: boolean
  onAbortRequest: () => void
  onAbortCancel: () => void
}

const triggerOf = (event: MouseEvent<HTMLElement>): FocusTarget => event.currentTarget

/** Hook-free banner (static rendering in tests); {@link OperationBanner} owns the abort confirmation. */
export function OperationBannerView(props: OperationBannerViewProps): ReactNode {
  const { t, operation, conflicts, branch = null, step = null, busy = false, blockReason = null } = props
  if (operation === null) return null
  const name = t(OPERATION_LABEL[operation])
  const writable = operation !== 'bisect' && (props.onContinue !== undefined || props.onAbort !== undefined)
  const writeDisabled = busy || blockReason !== null
  const continueBlocked = conflicts > 0 ? t('banner.continueBlocked', { count: conflicts }) : null
  const writeTitle = blockReason ?? undefined
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${css.banner} ${conflicts > 0 ? css.hasConflicts : ''}`}
      data-operation={operation}
      data-conflicts={conflicts}
    >
      <div className={css.row}>
        <span className={css.icon} aria-hidden="true">⚠</span>
        <strong className={css.title}>{t('banner.title', { operation: name })}</strong>
        {step === null ? null : <span className={css.step} data-step>{t('banner.step', { current: step.current, total: step.total })}</span>}
        {branch === null ? null : <span className={css.detail}>→ {branch}</span>}
        {conflicts > 0 ? <span className={css.conflicts}>· {t('count.conflicts', { count: conflicts })}</span> : null}
        {writable ? null : <span className={css.hint}>{t('banner.hint')}</span>}
        <span className={css.spacer} />
        {writable && conflicts > 0 && props.onResolve !== undefined
          ? <Button tone="primary" data-banner-action="resolve" onClick={(event) => { props.onResolve?.(triggerOf(event)) }}>{t('banner.resolve')}</Button>
          : null}
        {writable && props.onContinue !== undefined
          ? (
              <Button
                tone={conflicts > 0 ? 'ghost' : 'primary'}
                disabled={writeDisabled || continueBlocked !== null}
                title={writeTitle ?? continueBlocked ?? undefined}
                data-banner-action="continue"
                onClick={(event) => { props.onContinue?.(triggerOf(event)) }}
              >
                {t('banner.continue')}
              </Button>
            )
          : null}
        {writable && SKIPPABLE.has(operation) && props.onSkip !== undefined
          ? (
              <Button
                disabled={writeDisabled}
                title={writeTitle ?? t('banner.skip.title')}
                data-banner-action="skip"
                onClick={(event) => { props.onSkip?.(triggerOf(event)) }}
              >
                {t('banner.skip')}
              </Button>
            )
          : null}
        {writable && props.onAbort !== undefined
          ? (
              <Button
                tone="danger"
                disabled={writeDisabled || props.confirmingAbort}
                title={writeTitle}
                data-banner-action="abort"
                data-danger
                onClick={props.onAbortRequest}
              >
                {t('banner.abort')}
              </Button>
            )
          : null}
        {props.onOpenConsole === undefined ? null : <Button onClick={props.onOpenConsole}>{t('banner.openConsole')}</Button>}
      </div>
      {props.pendingStash === true ? <div className={css.note} data-pending-stash>{t('banner.pendingStash')}</div> : null}
      {writable && props.confirmingAbort
        ? (
            <div className={css.confirm} role="alert" data-abort-confirm>
              <span className={css.confirmText}>{t('banner.abort.confirm', { operation: name })}</span>
              <Button data-banner-action="abort-cancel" onClick={props.onAbortCancel}>{t('banner.abort.cancel')}</Button>
              <Button
                tone="danger"
                disabled={writeDisabled}
                data-banner-action="abort-confirm"
                data-danger
                onClick={(event) => { props.onAbort?.(triggerOf(event)) }}
              >
                {t('banner.abort.confirmButton', { operation: name })}
              </Button>
            </div>
          )
        : null}
    </div>
  )
}

export interface PendingStashBarProps {
  /** An operation control is running: restore waits. */
  busy?: boolean
  /** Why writes are disabled (read-only repository); null when allowed. */
  blockReason?: string | null
  onRestore: (trigger: FocusTarget | null) => void
  onGoStash: () => void
}

/**
 * Final review 2b: the operation that stashed the user's changes ended outside the UI (terminal,
 * Agent) and the stash was never restored. Stays until it is restored or gone.
 */
export function PendingStashBarView(props: PendingStashBarProps & { t: Translate }): ReactNode {
  const { t, busy = false, blockReason = null } = props
  return (
    <div role="status" aria-live="polite" className={css.banner} data-pending-stash-bar>
      <div className={css.row}>
        <span className={css.icon} aria-hidden="true">⚠</span>
        <span className={css.title}>{t('pendingStash.title')}</span>
        <span className={css.spacer} />
        <Button
          tone="primary"
          disabled={busy || blockReason !== null}
          title={blockReason ?? undefined}
          data-pending-stash-action="restore"
          onClick={(event) => { props.onRestore(triggerOf(event)) }}
        >
          {t('pendingStash.restore')}
        </Button>
        <Button data-pending-stash-action="goStash" onClick={props.onGoStash}>{t('notice.goStash')}</Button>
      </div>
    </div>
  )
}

export function PendingStashBar(props: PendingStashBarProps): ReactNode {
  const t = useT()
  return <PendingStashBarView {...props} t={t} />
}

export function OperationBanner(props: OperationBannerProps): ReactNode {
  const t = useT()
  const [confirmingAbort, setConfirmingAbort] = useState(false)
  // A different operation (or none) drops a pending confirmation.
  const [confirmFor, setConfirmFor] = useState(props.operation)
  if (confirmFor !== props.operation) {
    setConfirmFor(props.operation)
    if (confirmingAbort) setConfirmingAbort(false)
  }
  return (
    <OperationBannerView
      {...props}
      t={t}
      confirmingAbort={confirmingAbort}
      onAbortRequest={() => { setConfirmingAbort(true) }}
      onAbortCancel={() => { setConfirmingAbort(false) }}
      onAbort={props.onAbort === undefined
        ? undefined
        : (trigger) => {
            setConfirmingAbort(false)
            props.onAbort?.(trigger)
          }}
    />
  )
}
