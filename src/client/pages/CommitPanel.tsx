// Commit page (design §8.2): changes tree + message + actions, with disabled reasons,
// rewrite-history warning, success feedback and actionable errors.
// The workbench owns both stores and passes their states; Host calls go through the commit store.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CommitResultValue, StatusValue, WritePolicyValue } from '../../shared/protocol.ts'
import { activeFocusTarget } from '../focus.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import type { ChangesState, ChangesStore } from '../store/changes-store.ts'
import { commitErrorView, commitGate, operationGate, visibleMessage } from '../store/commit-store.ts'
import type { CommitGate, CommitMode, CommitOutcome, CommitStore, CommitStoreState } from '../store/commit-store.ts'
import { ChangesTree } from './ChangesTree.tsx'
import type { DiffOpenScope } from './ChangesTree.tsx'
import { CommitMessage } from './CommitMessage.tsx'
import css from './CommitPanel.module.css'


export interface CommittedInfo {
  mode: CommitMode
  /** Paths that were committed (empty for a message-only amend). */
  paths: string[]
}

export interface RunCommitDeps {
  commitStore: CommitStore
  changesStore: ChangesStore
  gate: CommitGate
  /** Push after a successful commit. */
  push?: boolean
  /** Always go through the Push page (the ▾ menu item). */
  openPushPage?: boolean
  onCommitted?: (result: CommitResultValue, info: CommittedInfo) => void
  onPushAfterCommit?: (result: CommitResultValue, options: { openPushPage: boolean }) => void
}

/**
 * One user commit action: submit the checked paths, then uncheck them and notify the workbench.
 * Repeated triggers while a commit is in flight (double click, Cmd+Enter spam) are ignored.
 * @returns the outcome, or null when nothing was started.
 */
export async function runCommit(deps: RunCommitDeps): Promise<CommitOutcome | null> {
  const { commitStore, changesStore, gate } = deps
  if (commitStore.getState().phase === 'submitting' || !gate.canSubmit) return null
  const push = deps.push === true && gate.canPush
  const outcome = await commitStore.submit(changesStore.getCheckedPaths())
  if (!outcome.ok) return outcome
  changesStore.uncheck(outcome.paths)
  deps.onCommitted?.(outcome.value, { mode: outcome.mode, paths: outcome.paths })
  if (push) deps.onPushAfterCommit?.(outcome.value, { openPushPage: deps.openPushPage === true || gate.pushNeedsPage })
  return outcome
}

export interface CommitPanelProps {
  changesStore: ChangesStore
  changes: ChangesState
  commitStore: CommitStore
  commit: CommitStoreState
  status: StatusValue | null
  writePolicy: WritePolicyValue
  /** `BootstrapValue.pendingWrites`. */
  pendingWrites?: number
  onOpenDiff: (path: string, scope: DiffOpenScope) => void
  onRollback?: (paths: string[]) => void
  /** B3c: the changelist grouping toggle and, when on, the grouped view replacing the tree. */
  changelists?: { grouped: boolean; onGrouped: (on: boolean) => void; panel: ReactNode }
  /** B3c: shelve the row (or the checked files when the row is checked). */
  onShelve?: (path: string, trigger: HTMLElement | null) => void
  onAddToVcs?: (paths: string[]) => void
  onCopyPath?: (path: string) => void
  /** B2: file history / worktree blame from a change row's menu. */
  onFileHistory?: (path: string) => void
  onBlame?: (path: string) => void
  /** After a successful commit: refresh status/log and highlight the new HEAD. */
  onCommitted?: (result: CommitResultValue, info: CommittedInfo) => void
  /** "Commit and push": push directly when `openPushPage` is false, otherwise open the Push page. */
  onPushAfterCommit?: (result: CommitResultValue, options: { openPushPage: boolean }) => void
  onShowConsole: () => void
  /** Refresh the status snapshot (for `git/paths-changed`). */
  onRefresh?: () => void
  /**
   * Operation-state commit (A3 T9, `commit.mode !== 'normal'`): merge commit or continue.
   * `trigger` is the clicked button (the conflict list may open after a continue).
   */
  onOperationSubmit?: (trigger: FocusTarget | null) => void
  /** "解决冲突…" next to the disabled operation button. */
  onResolveConflicts?: (trigger: FocusTarget | null) => void
}

function Feedback({ commit, commitStore, onShowConsole, onRefresh }: {
  commit: CommitStoreState
  commitStore: CommitStore
  onShowConsole: () => void
  onRefresh?: (() => void) | undefined
}): ReactNode {
  const t = useT()
  if (commit.phase === 'failure' && commit.error !== null) {
    const view = commitErrorView(commit.error, t)
    return (
      <div role="alert" className={css.error} data-error-code={commit.error.code}>
        <strong className={css.errorTitle}>{view.title}</strong>
        {view.detail === null ? null : <pre className={css.errorDetail}>{view.detail}</pre>}
        <div className={css.errorActions}>
          {view.action === 'console' ? <Button onClick={onShowConsole}>{t('write.showConsole')}</Button> : null}
          {view.action === 'refresh' && onRefresh !== undefined ? <Button onClick={onRefresh}>{t('action.refresh')}</Button> : null}
          <Button onClick={() => commitStore.dismiss()}>{t('action.close')}</Button>
        </div>
      </div>
    )
  }
  if (commit.phase === 'success' && commit.lastCommit !== null) {
    return (
      <div role="status" className={css.success} data-committed={commit.lastCommit.sha}>
        <span>{t('commit.committed', { sha: commit.lastCommit.shortSha })}</span>
        <button type="button" className={css.dismiss} aria-label={t('action.close')} onClick={() => commitStore.dismiss()}>✕</button>
      </div>
    )
  }
  return null
}

/**
 * The commit page.
 * @param props - stores and their states, repository snapshot and workbench callbacks.
 * @returns tree, message, actions and feedback.
 */
export function CommitPanel(props: CommitPanelProps): ReactNode {
  if (props.commit.mode !== 'normal') return <OperationCommitPanel {...props} />
  return <NormalCommitPanel {...props} />
}

/** Commit page during a merge / cherry-pick / revert / rebase (design §8.2.4 table). */
function OperationCommitPanel(props: CommitPanelProps): ReactNode {
  const t = useT()
  const { changes, changesStore, commit, commitStore } = props
  const mode = commit.mode === 'normal' ? 'merge' : commit.mode
  const message = visibleMessage(commit)
  const gate = operationGate({
    mode,
    writePolicy: props.writePolicy,
    status: props.status,
    pendingWrites: props.pendingWrites ?? 0,
    message,
    phase: commit.phase,
  }, t)
  const submit = (trigger: FocusTarget | null): void => {
    if (gate.canSubmit) props.onOperationSubmit?.(trigger)
  }
  return (
    <div className={css.root} data-commit-panel data-phase={commit.phase} data-operation-mode={mode}>
      <div className={css.tree}>
        <ChangesTree
          state={changes}
          store={changesStore}
          writeDisabled
          checksDisabled
          onOpenDiff={props.onOpenDiff}
          {...(props.onCopyPath === undefined ? {} : { onCopyPath: props.onCopyPath })}
          {...(props.onFileHistory === undefined ? {} : { onFileHistory: props.onFileHistory })}
          {...(props.onBlame === undefined ? {} : { onBlame: props.onBlame })}
        />
      </div>
      <div className={css.bottom}>
        <strong className={css.operationTitle}>{gate.title}</strong>
        {gate.showMessage
          ? (
              <CommitMessage
                value={message}
                onChange={value => commitStore.setMessage(value)}
                onSubmit={() => { submit(activeFocusTarget()) }}
                history={commit.history}
                onPickHistory={value => commitStore.applyHistory(value)}
                disabled={gate.blocked}
              />
            )
          : null}
        <p className={css.operationHint} data-operation-explanation>{gate.explanation}</p>
        <div className={css.actions}>
          {gate.conflicts > 0 && props.onResolveConflicts !== undefined
            ? (
                <Button data-resolve-conflicts onClick={(event) => { props.onResolveConflicts?.(event.currentTarget) }}>
                  {t('commit.op.resolve')}
                </Button>
              )
            : null}
          <span className={css.spacer} />
          <Button
            tone="primary"
            disabled={!gate.canSubmit}
            aria-busy={gate.submitting}
            title={gate.disabledReason ?? undefined}
            data-commit-submit={mode}
            onClick={(event) => { submit(event.currentTarget) }}
          >
            {gate.submitting ? t('commit.submitting') : gate.submitLabel}
          </Button>
        </div>
        {gate.disabledReason === null
          ? null
          : (
              <ul className={css.notes}>
                <li className={css.reason} data-note="reason">{gate.disabledReason}</li>
              </ul>
            )}
        <Feedback commit={commit} commitStore={commitStore} onShowConsole={props.onShowConsole} onRefresh={props.onRefresh} />
      </div>
    </div>
  )
}

function NormalCommitPanel(props: CommitPanelProps): ReactNode {
  const t = useT()
  const { changes, changesStore, commit, commitStore } = props
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [pushMenuOpen, setPushMenuOpen] = useState(false)
  const pushMenuRef = useRef<HTMLDivElement>(null)
  const gate = commitGate({
    writePolicy: props.writePolicy,
    status: props.status,
    pendingWrites: props.pendingWrites ?? 0,
    checkedCount: changes.checked.size,
    message: commit.message,
    amend: commit.amend,
    phase: commit.phase,
  }, t)

  useEffect(() => {
    if (!pushMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (pushMenuRef.current !== null && event.target instanceof Node && pushMenuRef.current.contains(event.target)) return
      setPushMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [pushMenuOpen])

  const submit = (push = false, openPushPage = false): void => {
    void runCommit({
      commitStore,
      changesStore,
      gate,
      push,
      openPushPage,
      ...(props.onCommitted === undefined ? {} : { onCommitted: props.onCommitted }),
      ...(props.onPushAfterCommit === undefined ? {} : { onPushAfterCommit: props.onPushAfterCommit }),
    })
  }

  const notes: { kind: 'reason' | 'warning' | 'hint'; text: string }[] = []
  if (gate.disabledReason !== null) notes.push({ kind: 'reason', text: gate.disabledReason })
  if (gate.rewriteWarning !== null) notes.push({ kind: 'warning', text: gate.rewriteWarning })
  if (gate.detachedHint !== null) notes.push({ kind: 'hint', text: gate.detachedHint })

  return (
    <div className={css.root} data-commit-panel data-phase={commit.phase}>
      {props.changelists === undefined ? null : (
        <label className={css.groupToggle}>
          <input type="checkbox" checked={props.changelists.grouped} data-changelist-grouping onChange={(event) => { props.changelists?.onGrouped(event.target.checked) }} />
          {t('changelist.group')}
        </label>
      )}
      <div className={css.tree}>
        {props.changelists?.grouped === true ? props.changelists.panel : (
        <ChangesTree
          state={changes}
          store={changesStore}
          writeDisabled={gate.blocked}
          onOpenDiff={props.onOpenDiff}
          onCommitFile={() => { textareaRef.current?.focus() }}
          {...(props.onRollback === undefined ? {} : { onRollback: props.onRollback })}
          {...(props.onShelve === undefined ? {} : { onShelve: props.onShelve })}
          {...(props.onAddToVcs === undefined ? {} : { onAddToVcs: props.onAddToVcs })}
          {...(props.onCopyPath === undefined ? {} : { onCopyPath: props.onCopyPath })}
          {...(props.onFileHistory === undefined ? {} : { onFileHistory: props.onFileHistory })}
          {...(props.onBlame === undefined ? {} : { onBlame: props.onBlame })}
        />
        )}
      </div>
      <div className={css.bottom}>
        <CommitMessage
          value={commit.message}
          onChange={message => commitStore.setMessage(message)}
          onSubmit={() => submit()}
          history={commit.history}
          onPickHistory={message => commitStore.applyHistory(message)}
          disabled={gate.blocked}
          textareaRef={textareaRef}
        />
        <div className={css.actions}>
          <label className={css.amend} title={t('commit.amendTitle')}>
            <input
              type="checkbox"
              checked={commit.amend}
              disabled={gate.blocked || gate.submitting}
              onChange={event => commitStore.setAmend(event.target.checked)}
            />
            {t('commit.amend')}
          </label>
          <span className={css.spacer} />
          {/* Carry 4: unmerged files without an operation (restoring a stash conflicted). */}
          {(props.status?.conflicts.length ?? 0) > 0 && props.onResolveConflicts !== undefined
            ? (
                <Button data-resolve-conflicts onClick={(event) => { props.onResolveConflicts?.(event.currentTarget) }}>
                  {t('commit.op.resolve')}
                </Button>
              )
            : null}
          <Button
            tone="primary"
            disabled={!gate.canSubmit}
            aria-busy={gate.submitting}
            title={gate.disabledReason ?? undefined}
            data-commit-submit={gate.mode}
            onClick={() => submit()}
          >
            {gate.submitting ? t('commit.submitting') : gate.submitLabel}
          </Button>
          <div ref={pushMenuRef} className={css.split}>
            <Button
              disabled={!gate.canPush}
              title={commit.amend ? t('commit.reasonPushAmend') : (gate.disabledReason ?? undefined)}
              data-commit-push=""
              onClick={() => submit(true)}
            >
              {t('commit.commitAndPush')}
            </Button>
            <Button
              aria-label={t('commit.pushMenu')}
              aria-haspopup="menu"
              aria-expanded={pushMenuOpen}
              disabled={!gate.canPush}
              onClick={() => setPushMenuOpen(open => !open)}
            >
              ▾
            </Button>
            {pushMenuOpen
              ? (
                  <div role="menu" className={css.menu}>
                    <button
                      type="button"
                      role="menuitem"
                      className={css.menuItem}
                      onClick={() => { setPushMenuOpen(false); submit(true, true) }}
                    >
                      {t('commit.commitAndOpenPush')}
                    </button>
                  </div>
                )
              : null}
          </div>
        </div>
        {notes.length === 0
          ? null
          : (
              <ul className={css.notes}>
                {notes.map(note => (
                  <li key={note.kind} className={css[note.kind]} data-note={note.kind}>{note.text}</li>
                ))}
              </ul>
            )}
        <Feedback commit={commit} commitStore={commitStore} onShowConsole={props.onShowConsole} onRefresh={props.onRefresh} />
      </div>
    </div>
  )
}
