// Operation control and conflict resolution (design §7.3, §8.2.4, §10.2–10.4; plan A3 T9).
// What is sent for banner / conflict-list / commit-page actions and how an outcome maps to the
// workbench (notice, show the new HEAD in the log, reload the conflict list). React-free.
import type {
  CommitResultValue,
  ConflictResolution,
  FileEntry,
  MergeFileValue,
  OperationCommitValue,
  OperationControlAction,
  OperationControlValue,
  OperationStateValue,
  RpcResult,
} from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore, ActionStatus } from '../store/action-store.ts'
import type { CommitPageMode } from '../store/commit-store.ts'
import { allResolved, autoMerge } from '../merge/merge-model.ts'
import { isTextConflict } from '../store/conflict-store.ts'
import { mergeTexts } from '../store/merge-store.ts'
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

/**
 * 「还原冲突解决」 of a resolved row (`git checkout -m`, AC9). The Host answers `git/exec-failed`
 * when the resolution cannot be undone here (a delete-kind conflict: restore it in a terminal) and
 * `git/stale-target` when the path has no conflict record to restore (never conflicted).
 */
export async function unresolveConflictFile(deps: OperationDeps, path: string): Promise<ResolveResult> {
  const outcome = await deps.actions.run('unresolveConflict', { path }, { target: path, trigger: deps.trigger })
  switch (outcome.kind) {
    case 'done':
      return { kind: 'done' }
    case 'cancelled':
      return { kind: 'stay' }
    case 'conflict':
      return { kind: 'error', message: text('action.error.git/conflict') }
    case 'failed':
      if (outcome.error.code === 'git/exec-failed') return { kind: 'error', message: text('conflict.unresolve.terminal') }
      if (outcome.error.code === 'git/stale-target') return { kind: 'error', message: text('conflict.unresolve.unavailable'), stale: true }
      return { kind: 'error', message: outcome.message }
  }
}

export interface SimpleAllDeps extends OperationDeps {
  loadFile: (path: string) => Promise<RpcResult<MergeFileValue>>
}

export interface SimpleAllOutcome {
  /** Written back with mergeApply (resolved but not reviewed). */
  resolved: string[]
  /** Left for the user: not a text conflict, unreadable, has a draft, not fully automatic, or the write failed. */
  manual: string[]
}

/**
 * 「全部简单冲突」 (design §10.2 P1, AC6): one file after another (serially, through the write queue)
 * load the three sides, replay applyNonConflicting('all') + resolveSimple, and write the Result back
 * only when every chunk is resolved. Nothing else is written (no drafts). A file with a saved draft is
 * someone's work in progress and is left alone.
 */
export async function resolveAllSimple(deps: SimpleAllDeps, entries: readonly FileEntry[]): Promise<SimpleAllOutcome> {
  const outcome: SimpleAllOutcome = { resolved: [], manual: [] }
  for (const entry of entries) {
    const path = entry.path
    if (!isTextConflict(entry)) {
      outcome.manual.push(path)
      continue
    }
    let loaded: RpcResult<MergeFileValue>
    try {
      loaded = await deps.loadFile(path)
    } catch {
      outcome.manual.push(path)
      continue
    }
    const file = loaded.ok ? loaded.value : null
    const texts = file === null ? null : mergeTexts(file)
    const model = texts === null || file?.draft !== null ? null : autoMerge(texts)
    if (file === null || model === null || !allResolved(model)) {
      outcome.manual.push(path)
      continue
    }
    const applied = await deps.actions.run('mergeApply', {
      path,
      result: model.result,
      stages: { base: file.base?.blob ?? null, ours: file.ours?.blob ?? null, theirs: file.theirs?.blob ?? null },
      expectedWorktreeSha: file.worktreeSha,
    }, { target: path, trigger: deps.trigger })
    if (applied.kind === 'done') outcome.resolved.push(path)
    else outcome.manual.push(path)
  }
  return outcome
}

/** 「已解决 N 个文件，M 个文件需要手动处理」. */
export function simpleAllSummary(outcome: SimpleAllOutcome): LocalizedText {
  return text('conflict.simpleAll.done', { resolved: outcome.resolved.length, manual: outcome.manual.length })
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
