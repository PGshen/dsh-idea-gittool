// Operation control and conflict resolution (design §7.3, §8.2.4, §10.2–10.4; plan A3 T9).
// What is sent for banner / conflict-list / commit-page actions and how an outcome maps to the
// workbench (notice, show the new HEAD in the log, reload the conflict list). React-free.
import type {
  CommitResultValue,
  ConflictResolution,
  OperationCommitValue,
  OperationControlAction,
  OperationControlValue,
  OperationStateValue,
} from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore, ActionStatus } from '../store/action-store.ts'
import type { CommitPageMode } from '../store/commit-store.ts'
import { normalizeMessage } from '../store/commit-store.ts'
import type { ActionNotice } from './branch-actions.ts'
import { failedNotice, stashNotice } from './branch-actions.ts'

export { stashNotice }

export interface OperationDeps {
  actions: Pick<ActionStore, 'run'>
  /** The control the user clicked (the conflict list opened by a conflict returns focus to it). */
  trigger: FocusTarget | null
}

/** Banner "continue / skip / abort" (abort only after the banner's confirmation). */
export function controlOperation(deps: OperationDeps, action: OperationControlAction): Promise<ActionOutcome<OperationControlValue>> {
  return deps.actions.run('operationControl', { action }, { trigger: deps.trigger })
}

function commitMerge(deps: OperationDeps, message: string): Promise<ActionOutcome<OperationCommitValue>> {
  return deps.actions.run('operationCommit', { message: normalizeMessage(message) }, { trigger: deps.trigger })
}

/** Message of the merge commit: the user's text, else MERGE_MSG, else git's default wording. */
export function mergeMessageOf(value: OperationStateValue, edited: string): string {
  if (edited.trim() !== '') return edited
  if (value.message !== undefined && value.message.trim() !== '') return value.message
  return `Merge branch '${value.theirs.label}' into ${value.ours.label}`
}

/**
 * Commit page prefill in a merge (carry 10): MERGE_MSG, else the same default wording the
 * conflict list commits with. Undefined outside a merge.
 */
export function mergePrefill(value: OperationStateValue | null): string | undefined {
  return value?.operation === 'merge' ? mergeMessageOf(value, '') : undefined
}

/** "Accept and finish" of the conflict list: merge → merge commit, the others → continue. */
export function finishOperation(deps: OperationDeps, value: OperationStateValue, message: string): Promise<ActionOutcome<unknown>> {
  return value.operation === 'merge' ? commitMerge(deps, message) : controlOperation(deps, 'continue')
}

/** Primary button of the commit page in an operation state. */
export function submitOperationStep(deps: OperationDeps, mode: Exclude<CommitPageMode, 'normal'>, message: string): Promise<ActionOutcome<unknown>> {
  return mode === 'merge' ? commitMerge(deps, message) : controlOperation(deps, 'continue')
}

export type ResolveResult =
  | { kind: 'done' }
  /** mark-resolved found conflict markers: confirm, then resend with `force`. */
  | { kind: 'markers'; path: string }
  /** `stale`: the path is no longer in the conflict list (the caller reloads it). */
  | { kind: 'error'; message: LocalizedText; stale?: true }
  | { kind: 'stay' }

export async function resolveConflictFile(
  deps: OperationDeps,
  path: string,
  resolution: ConflictResolution,
  force = false,
): Promise<ResolveResult> {
  const payload = force ? { path, resolution, force: true } : { path, resolution }
  const outcome = await deps.actions.run('resolveConflict', payload, { trigger: deps.trigger })
  switch (outcome.kind) {
    case 'done':
      return { kind: 'done' }
    case 'cancelled':
      return { kind: 'stay' }
    case 'conflict':
      if (outcome.details.markers === true) return { kind: 'markers', path }
      return { kind: 'error', message: text('action.error.git/conflict') }
    case 'failed':
      return outcome.error.code === 'git/stale-target'
        ? { kind: 'error', message: outcome.message, stale: true }
        : { kind: 'error', message: outcome.message }
  }
}

export type OperationStepKind = OperationControlAction | 'commit'

export interface OperationEffect {
  notice: ActionNotice | null
  /** The operation ended (completed or aborted): close the conflict list. */
  finished: boolean
  /** Completed: switch to the log and highlight this commit (design §8.2.4 / §10.4). */
  showInLog: string | null
  /** Stopped at (another) conflict: reload the conflict list. */
  refreshConflicts: boolean
}

const NOTHING: OperationEffect = { notice: null, finished: false, showInLog: null, refreshConflicts: false }

export function operationOutcomeEffect(outcome: ActionOutcome<unknown>, step: OperationStepKind): OperationEffect {
  switch (outcome.kind) {
    case 'cancelled':
      return NOTHING
    case 'failed':
      return { ...NOTHING, notice: failedNotice(outcome) }
    case 'conflict':
      return { ...NOTHING, refreshConflicts: true }
    case 'done':
      break
  }
  const value = (outcome.value ?? {}) as Partial<OperationControlValue & CommitResultValue>
  const notice = stashNotice(value)
  if (step === 'commit') {
    return { notice, finished: true, showInLog: typeof value.sha === 'string' ? value.sha : null, refreshConflicts: false }
  }
  const finished = value.operation === null || value.operation === undefined
  if (!finished) return { ...NOTHING, notice }
  const showInLog = step === 'abort' || typeof value.head !== 'string' ? null : value.head
  return { notice, finished: true, showInLog, refreshConflicts: false }
}

/**
 * 「恢复贮藏」 of the pending-stash bar (final review 2b): the operation already ended outside
 * the UI, so `continue` only restores the pending stash — the Host does that only when the
 * stash belongs to the current branch, otherwise it answers `stashKept`.
 */
export function restorePendingStash(deps: OperationDeps): Promise<ActionOutcome<OperationControlValue>> {
  return controlOperation(deps, 'continue')
}

/** Notice after 「恢复贮藏」: a restore is silent (the bar goes away); kept / missing / failures are told. */
export function pendingRestoreNotice(outcome: ActionOutcome<unknown>): ActionNotice | null {
  switch (outcome.kind) {
    case 'cancelled':
      return null
    case 'failed':
      return failedNotice(outcome)
    case 'conflict':
      return { tone: 'warning', message: text('operation.notice.stashKept'), action: 'goStash' }
    case 'done':
      return stashNotice((outcome.value ?? {}) as Partial<OperationControlValue>)
  }
}

/** An operation control or merge commit is in flight (banner and list buttons wait). */
export function operationBusy(pending: Readonly<Record<string, ActionStatus>>): boolean {
  return Object.keys(pending).some(key => key.startsWith('operationControl:') || key.startsWith('operationCommit:'))
}
