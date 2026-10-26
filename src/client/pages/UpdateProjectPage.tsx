// Update Project overlay page (design §11, plan A3 T8): merge or rebase onto the upstream.
// - Tracked changes: the "will stash first, restored afterwards" note IS the user's explicit
//   choice, so submitting sends `stash: true` and no further question is asked.
// - `git/upstream-rewritten` (force-pushed upstream): the page switches to an explanation with
//   "reset to remote" (the backup branch tick is on by default and never remembered) or cancel.
import { useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { PullMode, StatusValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { PULL_MODES, browserStorage, hasTrackedChanges, loadPrefs, savePrefs } from '../store/integrate-store.ts'
import type { KeyValueStorage } from '../store/push-store.ts'
import { backupNotice, submitResetToRemote, submitUpdateProject } from './integrate-actions.ts'
import type { ActionNotice } from './branch-actions.ts'
import { IntegrateFooter, MessageLines, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import css from './Integrate.module.css'
import { PushOverlayFrame } from './PushRejectedPage.tsx'

export interface UpdateProjectViewProps {
  t: Translate
  mode: PullMode
  /** Tracked changes exist: show the "will stash first" note. */
  stashNote: boolean
  noUpstream: boolean
  /** Set after `git/upstream-rewritten`. */
  rewritten: { localAhead: number } | null
  /** "Create backup branch" tick of the rewritten view. */
  backup: boolean
  busy: boolean
  error: LocalizedText | null
  block?: LocalizedText | undefined
  rootRef?: Ref<HTMLDivElement>
  onModeChange: (mode: PullMode) => void
  onBackupChange: (backup: boolean) => void
  onSubmit: (trigger: FocusTarget | null) => void
  onResetToRemote: (trigger: FocusTarget | null) => void
  onBack: () => void
}

export function UpdateProjectPageView(props: UpdateProjectViewProps): ReactNode {
  const { t, busy, rewritten } = props
  const title = t('integrate.update.title')
  const canSubmit = !props.noUpstream && props.block === undefined && !busy
  return (
    <PushOverlayFrame
      t={t}
      title={title}
      label={title}
      busy={busy}
      rootRef={props.rootRef}
      onBack={props.onBack}
      onKeyDown={escapeHandler(busy, props.onBack)}
    >
      {rewritten === null
        ? (
            <form className={css.body} onSubmit={formSubmit((trigger) => { if (canSubmit) props.onSubmit(trigger) })} data-integrate="update">
              <p className={css.hint}>{t('integrate.update.hint')}</p>
              <fieldset className={css.group} disabled={busy}>
                <legend className={css.legend}>{t('integrate.update.mode')}</legend>
                {PULL_MODES.map(mode => (
                  <label key={mode} className={css.choice}>
                    <input
                      type="radio"
                      name="update-mode"
                      checked={props.mode === mode}
                      data-update-mode={mode}
                      data-autofocus={props.mode === mode ? '' : undefined}
                      onChange={() => props.onModeChange(mode)}
                    />
                    <span>
                      {t(`integrate.mode.${mode}`)}
                      <span className={css.choiceHint}>{t(`integrate.mode.${mode}.hint`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {props.stashNote ? <p className={css.note} data-stash-note>{t('integrate.update.stashNote')}</p> : null}
              {props.noUpstream ? <p className={css.blockReason} role="status">{t('integrate.update.noUpstream')}</p> : null}
              <MessageLines t={t} block={props.block} error={props.error} />
              <IntegrateFooter t={t} label={t('integrate.update.submit')} busy={busy} canSubmit={canSubmit} onCancel={props.onBack} />
            </form>
          )
        : (
            <form className={css.body} onSubmit={formSubmit((trigger) => { if (!busy) props.onResetToRemote(trigger) })} data-upstream-rewritten>
              <p className={css.blockReason} role="alert">{t('integrate.update.rewritten.title')}</p>
              <p className={css.hint}>{t('integrate.update.rewritten.body', { count: rewritten.localAhead })}</p>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={props.backup}
                  disabled={busy}
                  data-backup
                  onChange={event => props.onBackupChange(event.target.checked)}
                />
                <span>{t('integrate.update.rewritten.backup')}</span>
              </label>
              {props.backup
                ? <p className={css.hint} data-backup-only>{t('integrate.update.rewritten.backupOnly')}</p>
                : <p className={css.error} role="status">{t('integrate.update.rewritten.noBackup', { count: rewritten.localAhead })}</p>}
              <MessageLines t={t} error={props.error} />
              <IntegrateFooter
                t={t}
                label={t('integrate.update.rewritten.reset')}
                busy={busy}
                canSubmit
                danger
                focusCancel
                onCancel={props.onBack}
              />
            </form>
          )}
    </PushOverlayFrame>
  )
}

export interface UpdateProjectPageProps {
  status: StatusValue | null
  block?: LocalizedText | undefined
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onNotice: (notice: ActionNotice) => void
  onClose: () => void
  storage?: KeyValueStorage | null
}

export function UpdateProjectPage({ status, block, actions, onOutcome, onNotice, onClose, storage }: UpdateProjectPageProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage])
  const [mode, setMode] = useState<PullMode>(() => loadPrefs(store).update)
  const [rewritten, setRewritten] = useState<{ localAhead: number } | null>(null)
  // Never remembered: the backup tick starts on every time the rewritten view appears.
  const [backup, setBackup] = useState(true)
  const { busy, error, clearError, run } = useFormRunner({ onOutcome, onNotice, onClose })
  // Again when the rewritten view replaces the form: Cancel, not the reset, gets the focus (carry 5).
  useInitialFocus(rootRef, rewritten !== null)
  const stashNote = hasTrackedChanges(status)
  const noUpstream = status === null || status.detached || status.upstream === null

  const submit = (trigger: FocusTarget | null): void => {
    if (busy || noUpstream || block !== undefined) return
    savePrefs(store, { ...loadPrefs(store), update: mode })
    run(() => submitUpdateProject({ actions, trigger }, { mode, stashFirst: stashNote }), {
      rewritten: (localAhead) => {
        setRewritten({ localAhead })
        setBackup(true)
      },
    })
  }

  const resetToRemote = (trigger: FocusTarget | null): void => {
    if (busy) return
    run(() => submitResetToRemote({ actions, trigger }, backup, status), {
      closed: (outcome) => {
        const notice = backupNotice(outcome)
        if (notice === null) onOutcome(outcome)
        else onNotice(notice)
      },
    })
  }

  return (
    <UpdateProjectPageView
      t={t}
      mode={mode}
      stashNote={stashNote}
      noUpstream={noUpstream}
      rewritten={rewritten}
      backup={backup}
      busy={busy}
      error={error}
      block={block}
      rootRef={rootRef}
      onModeChange={(value) => { setMode(value); clearError() }}
      onBackupChange={setBackup}
      onSubmit={submit}
      onResetToRemote={resetToRemote}
      onBack={onClose}
    />
  )
}
