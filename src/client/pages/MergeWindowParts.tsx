// B1 T6 pieces of the merge window (split from MergeWindow.tsx by responsibility): header,
// footer (with the "apply non-conflicting changes" menu), the apply / leave questions and the
// two-choice fallback for binary, too large and delete-kind conflicts.
import type { MouseEvent, ReactNode } from 'react'
import type { ConflictResolution } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import type { Translate } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { MergeSideName } from '../merge/merge-model.ts'
import type { ConflictRowAction } from '../store/conflict-store.ts'
import type { MergeAction } from '../store/merge-store.ts'
import { Button } from '../ui/Button.tsx'
import menuCss from './CommitContextMenu.module.css'
import type { LeaveAnswer, MergeConfirm } from './merge-window-controller.ts'
import css from './MergeWindow.module.css'

/** Names of both sides as the user knows them (design §10.1), plus Git's technical meaning. */
export interface MergeSideLabel {
  /** Branch name / short hash: "main", "feat/x", "4abcdef". */
  label: string
  /** "main（当前分支）". */
  name: string
  /** "Git 的 ours（:2:）". */
  technical: string
}

export interface MergeSideLabels {
  left: MergeSideLabel
  right: MergeSideLabel
  /** Rebase only: Git's ours is the target branch. */
  note: string | null
}

const triggerOf = (event: MouseEvent<HTMLElement>): FocusTarget => event.currentTarget

export interface MergeHeaderProps {
  t: Translate
  path: string
  counts: { resolved: number; total: number } | null
  hasPrev: boolean
  hasNext: boolean
  canUndo: boolean
  busy: boolean
  /** Save and close writes a draft: disabled in read-only mode. */
  blockReason: string | null
  /** The two-choice fallback has no draft to save. */
  canSave: boolean
  onBack: () => void
  onPrevFile: () => void
  onNextFile: () => void
  onUndo: () => void
  onSaveClose: () => void
}

export function MergeHeader(props: MergeHeaderProps): ReactNode {
  const { t, counts, busy, blockReason } = props
  return (
    <header className={css.header}>
      <Button className={css.back} title={t('diff.back.title')} disabled={busy} data-merge-back onClick={props.onBack}>{t('diff.back')}</Button>
      <strong className={css.title} title={props.path}>{t('merge.title', { path: props.path })}</strong>
      {counts === null || counts.total === 0
        ? null
        : <span className={css.counts} title={t('merge.counts.title')} data-merge-counts>{t('merge.counts', counts)}</span>}
      <span className={css.headerActions}>
        <Button disabled={!props.hasPrev || busy} data-merge-prev-file onClick={props.onPrevFile}>{t('merge.file.prev')}</Button>
        <Button disabled={!props.hasNext || busy} data-merge-next-file onClick={props.onNextFile}>{t('merge.file.next')}</Button>
        <Button disabled={!props.canUndo || busy} title={t('merge.undo.title')} data-merge-undo onClick={props.onUndo}>{t('merge.undo')}</Button>
        <Button
          disabled={busy || blockReason !== null || !props.canSave}
          title={blockReason ?? t('merge.saveClose.title')}
          data-merge-save
          onClick={props.onSaveClose}
        >
          {t('merge.saveClose')}
        </Button>
      </span>
    </header>
  )
}

export interface MergeFooterProps {
  t: Translate
  sides: MergeSideLabels
  busy: boolean
  applied: boolean
  blockReason: string | null
  nonConflictingOpen: boolean
  onAction: (action: MergeAction) => void
  onToggleNonConflicting: () => void
  onApply: () => void
}

export function MergeFooter(props: MergeFooterProps): ReactNode {
  const { t, sides, busy, blockReason } = props
  const fileButton = (side: MergeSideName): ReactNode => {
    const label = sides[side]
    return (
      <Button
        disabled={busy}
        title={t('merge.file.accept.title', { name: label.name, side: label.technical })}
        data-merge-accept-file={side}
        onClick={() => { props.onAction({ type: 'acceptFile', side }) }}
      >
        {t('merge.file.accept', { label: label.label })}
      </Button>
    )
  }
  const menuItem = (which: MergeSideName | 'all', label: string): ReactNode => (
    <button
      type="button"
      role="menuitem"
      className={menuCss.item}
      data-non-conflicting={which}
      onClick={() => {
        props.onToggleNonConflicting()
        props.onAction({ type: 'applyNonConflicting', which })
      }}
    >
      {label}
    </button>
  )
  return (
    <footer className={css.footer}>
      {fileButton('left')}
      {fileButton('right')}
      <span className={css.menuAnchor}>
        <Button
          disabled={busy}
          title={t('merge.nonConflicting.title')}
          aria-haspopup="menu"
          aria-expanded={props.nonConflictingOpen}
          data-merge-non-conflicting
          onClick={props.onToggleNonConflicting}
        >
          {t('merge.nonConflicting')} ▾
        </Button>
        {props.nonConflictingOpen
          ? (
              <span className={`${menuCss.menu ?? ''} ${css.menu ?? ''}`} role="menu" aria-label={t('merge.nonConflicting')}>
                {menuItem('left', t('merge.nonConflicting.left', { label: sides.left.label }))}
                {menuItem('all', t('merge.nonConflicting.all'))}
                {menuItem('right', t('merge.nonConflicting.right', { label: sides.right.label }))}
              </span>
            )
          : null}
      </span>
      <Button disabled={busy} title={t('merge.simple.title')} data-merge-simple onClick={() => { props.onAction({ type: 'resolveSimple' }) }}>
        {t('merge.simple')}
      </Button>
      <Button disabled={busy} title={t('merge.revert.title')} data-merge-revert onClick={() => { props.onAction({ type: 'revert' }) }}>
        {t('merge.revert')}
      </Button>
      <span className={css.spacer} />
      <Button
        tone="primary"
        disabled={busy || props.applied || blockReason !== null}
        title={blockReason ?? t('merge.apply.title')}
        aria-busy={busy}
        data-merge-apply
        onClick={props.onApply}
      >
        {t('merge.apply')}
      </Button>
    </footer>
  )
}

export interface MergeConfirmBarProps {
  t: Translate
  confirm: MergeConfirm
  busy: boolean
  /** Saving the draft is a write: disabled in read-only mode. */
  blockReason: string | null
  onConfirmApply: () => void
  onApplyNonConflictingFirst: () => void
  onCancel: () => void
  onLeaveAnswer: (answer: LeaveAnswer) => void
}

export function MergeConfirmBar({ t, confirm, busy, blockReason, onConfirmApply, onApplyNonConflictingFirst, onCancel, onLeaveAnswer }: MergeConfirmBarProps): ReactNode {
  if (confirm.kind === 'apply') {
    const lines = [
      ...(confirm.overwrite ? [t('merge.overwrite')] : []),
      ...(confirm.unresolved > 0 ? [t('merge.apply.confirm', { count: confirm.unresolved })] : []),
    ]
    return (
      <div className={css.confirm} role="alertdialog" aria-label={lines.join(' ')} data-merge-apply-confirm>
        {lines.map(line => <span key={line}>{line}</span>)}
        <span className={css.confirmActions}>
          <Button data-autofocus onClick={onCancel}>{t('action.cancel')}</Button>
          {confirm.unresolved > 0 && confirm.nonConflicting
            ? <Button disabled={busy} data-merge-apply-non-conflicting onClick={onApplyNonConflictingFirst}>{t('merge.apply.nonConflictingFirst')}</Button>
            : null}
          <Button tone="primary" disabled={busy} onClick={onConfirmApply}>{t('merge.apply.confirmButton')}</Button>
        </span>
      </div>
    )
  }
  return (
    <div className={css.confirm} role="alertdialog" aria-label={t('merge.leave.title')} data-merge-leave-confirm>
      <strong>{t('merge.leave.title')}</strong>
      <span>{t('merge.leave.body')}</span>
      <span className={css.confirmActions}>
        <Button data-merge-leave="cancel" onClick={() => { onLeaveAnswer('cancel') }}>{t('action.cancel')}</Button>
        <Button tone="danger" disabled={busy} data-merge-leave="discard" onClick={() => { onLeaveAnswer('discard') }}>{t('merge.leave.discard')}</Button>
        <Button
          tone="primary"
          disabled={busy || blockReason !== null}
          title={blockReason ?? undefined}
          data-autofocus
          data-merge-leave="save"
          onClick={() => { onLeaveAnswer('save') }}
        >
          {t('merge.leave.save')}
        </Button>
      </span>
    </div>
  )
}

export interface MergeFallbackProps {
  t: Translate
  reason: GitWorkbenchKey
  actions: readonly ConflictRowAction[]
  busy: boolean
  blockReason: string | null
  error: LocalizedText | null
  copied: boolean
  onResolve: (resolution: ConflictResolution, trigger: FocusTarget | null) => void
  onCopyCommand: (trigger: FocusTarget | null) => void
}

/** Binary, too large and delete-kind conflicts: the A3 row choices plus "resolve in terminal". */
export function MergeFallback(props: MergeFallbackProps): ReactNode {
  const { t, busy, blockReason } = props
  return (
    <div className={css.fallback} data-merge-fallback>
      <p className={css.fallbackReason}>{t(props.reason)}</p>
      <span className={css.fallbackActions}>
        {props.actions.map(action => (
          <Button
            key={action.id}
            tone={action.id === 'delete' ? 'danger' : 'ghost'}
            disabled={busy || blockReason !== null}
            title={blockReason ?? t(action.title.key, action.title.params)}
            data-resolution={action.resolution}
            onClick={(event) => { props.onResolve(action.resolution, triggerOf(event)) }}
          >
            {t(action.label.key, action.label.params)}
          </Button>
        ))}
        <Button title={t('conflict.terminal.title')} data-merge-terminal onClick={(event) => { props.onCopyCommand(triggerOf(event)) }}>
          {t('conflict.terminal')}
        </Button>
        {props.copied ? <span className={css.status} role="status">{t('conflict.copied')}</span> : null}
      </span>
      {props.error === null ? null : <p className={css.error} role="alert">{t(props.error.key, props.error.params)}</p>}
    </div>
  )
}
