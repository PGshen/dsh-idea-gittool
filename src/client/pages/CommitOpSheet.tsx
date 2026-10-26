// Confirmation sheet of "cherry-pick…" / "revert this commit…" from the log's commit menu
// (design §8.1.7, plan A3 T8). Both are smart operations: a dirty tree is handled by the action
// store's stash question after the button is pressed.
import { useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { submitCommitOp } from './integrate-actions.ts'
import type { ActionNotice } from './branch-actions.ts'
import { IntegrateFooter, MessageLines, SheetFrame, escapeHandler, formSubmit, useFormRunner, useInitialFocus } from './integrate-parts.tsx'
import sheetCss from './BranchSheets.module.css'

export type CommitOp = 'cherryPick' | 'revert'

export interface CommitOpSheetViewProps {
  t: Translate
  op: CommitOp
  shortSha: string
  subject: string
  busy: boolean
  error: LocalizedText | null
  rootRef?: Ref<HTMLDivElement>
  onSubmit: (trigger: FocusTarget | null) => void
  onCancel: () => void
}

export function CommitOpSheetView(props: CommitOpSheetViewProps): ReactNode {
  const { t, op, busy } = props
  const title = t(`integrate.commitOp.${op}.title`)
  return (
    <SheetFrame
      dataKind={op}
      title={title}
      subtitle={props.shortSha}
      label={`${title} ${props.shortSha}`}
      rootRef={props.rootRef}
      onCancel={() => { if (!busy) props.onCancel() }}
      onKeyDown={escapeHandler(busy, props.onCancel)}
    >
      <form className={sheetCss.body} onSubmit={formSubmit((trigger) => { if (!busy) props.onSubmit(trigger) })}>
        <p className={sheetCss.file} title={props.subject}>
          <code>{props.shortSha}</code> {props.subject.split('\n')[0]}
        </p>
        <p className={sheetCss.hint}>{t(`integrate.commitOp.${op}.hint`)}</p>
        <MessageLines t={t} error={props.error} />
        <IntegrateFooter t={t} label={t(`integrate.commitOp.${op}.submit`)} busy={busy} canSubmit onCancel={props.onCancel} />
      </form>
    </SheetFrame>
  )
}

export interface CommitOpSheetProps {
  op: CommitOp
  sha: string
  shortSha: string
  subject: string
  actions: Pick<ActionStore, 'run'>
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  onNotice: (notice: ActionNotice) => void
  onClose: () => void
}

export function CommitOpSheet({ op, sha, shortSha, subject, actions, onOutcome, onNotice, onClose }: CommitOpSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(rootRef)
  const { busy, error, run } = useFormRunner({ onOutcome, onNotice, onClose })

  const submit = (trigger: FocusTarget | null): void => {
    if (busy) return
    run(() => submitCommitOp({ actions, trigger }, op, sha))
  }

  return <CommitOpSheetView t={t} op={op} shortSha={shortSha} subject={subject} busy={busy} error={error} rootRef={rootRef} onSubmit={submit} onCancel={onClose} />
}
