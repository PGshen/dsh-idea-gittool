// Submit logic of the integrate forms (A3 T8): what is sent, through which smart-stash kind, and
// how an outcome maps to the form (close / stay / error / switch view). React-free.
// Smart operations never pre-ask on a dirty tree: `actions.run` shows the stash question itself.
import type {
  FetchValue,
  PullMode,
  ResetMode,
  ResetPreviewValue,
  ResetToRemoteValue,
  StatusValue,
} from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { mergeRequestOf } from '../store/integrate-store.ts'
import type { MergeOption } from '../store/integrate-store.ts'
import type { ActionNotice } from './branch-actions.ts'

export interface IntegrateDeps {
  actions: Pick<ActionStore, 'run'>
  /** The control the user clicked (async overlays opened by the action return focus to it). */
  trigger: FocusTarget | null
}

export type IntegrateResult =
  | { kind: 'closed'; outcome: ActionOutcome<unknown> }
  /** Nothing was sent or the user cancelled the stash question: the form stays as it is. */
  | { kind: 'stay' }
  | { kind: 'error'; message: LocalizedText; stale?: true }
  /** Update project: the upstream was force-pushed (the form switches to "reset to remote"). */
  | { kind: 'rewritten'; localAhead: number }

function settle(outcome: ActionOutcome<unknown>): IntegrateResult {
  switch (outcome.kind) {
    // On a conflict the action store has already opened the conflict list in place of the form.
    case 'done':
    case 'conflict':
      return { kind: 'closed', outcome }
    case 'cancelled':
      return { kind: 'stay' }
    case 'failed':
      return { kind: 'error', message: outcome.message }
  }
}

export async function submitMerge(deps: IntegrateDeps, form: { ref: string; option: MergeOption }): Promise<IntegrateResult> {
  return settle(await deps.actions.run('merge', mergeRequestOf(form.ref, form.option), { smartStash: 'merge', trigger: deps.trigger }))
}

export async function submitRebase(deps: IntegrateDeps, onto: string): Promise<IntegrateResult> {
  return settle(await deps.actions.run('rebase', { onto }, { smartStash: 'rebase', trigger: deps.trigger }))
}

export async function submitPull(deps: IntegrateDeps, form: { remote: string; branch: string; mode: PullMode }): Promise<IntegrateResult> {
  return settle(await deps.actions.run('pull', { remote: form.remote, branch: form.branch, mode: form.mode }, { smartStash: 'pull', trigger: deps.trigger }))
}

export async function submitCommitOp(deps: IntegrateDeps, op: 'cherryPick' | 'revert', sha: string): Promise<IntegrateResult> {
  const options = { trigger: deps.trigger }
  return settle(op === 'cherryPick'
    ? await deps.actions.run('cherryPick', { sha }, { smartStash: 'cherry-pick', ...options })
    : await deps.actions.run('revertCommit', { sha }, { smartStash: 'revert', ...options }))
}

/**
 * `stashFirst` is the user's explicit choice (the "will stash first" note): the request carries
 * `stash: true`, so the Host never answers `git/dirty-worktree`.
 */
export async function submitUpdateProject(
  deps: IntegrateDeps,
  form: { mode: PullMode; stashFirst: boolean },
): Promise<IntegrateResult> {
  const payload = form.stashFirst ? { mode: form.mode, stash: true as const } : { mode: form.mode }
  const outcome = await deps.actions.run('updateProject', payload, { smartStash: 'update', trigger: deps.trigger })
  if (outcome.kind === 'failed' && outcome.error.code === 'git/upstream-rewritten') {
    const ahead = outcome.error.details?.['localAhead']
    return { kind: 'rewritten', localAhead: typeof ahead === 'number' ? ahead : 0 }
  }
  return settle(outcome)
}

/** Paths listed inline in the "move or delete" message. */
const IN_THE_WAY_LISTED = 5

/**
 * Hard reset to the upstream after a force push; no stash is ever offered here.
 * `git/dirty-worktree` (no `operation`) comes either from tracked changes or from untracked /
 * ignored files the reset would overwrite; `status` tells them apart (carry 2): untracked files
 * must be moved or deleted, a stash cannot help.
 */
export async function submitResetToRemote(deps: IntegrateDeps, backup: boolean, status?: StatusValue | null): Promise<IntegrateResult> {
  const outcome = await deps.actions.run('resetToRemote', { backup }, { trigger: deps.trigger })
  if (outcome.kind === 'failed' && outcome.error.code === 'git/dirty-worktree') {
    const details = outcome.error.details ?? {}
    const raw = details['paths']
    const paths = Array.isArray(raw) ? raw.filter((path): path is string => typeof path === 'string') : []
    const count = typeof details['count'] === 'number' ? details['count'] : paths.length
    const tracked = new Set([...(status?.staged ?? []), ...(status?.unstaged ?? []), ...(status?.conflicts ?? [])].map(entry => entry.path))
    if (paths.some(path => tracked.has(path))) return { kind: 'error', message: text('integrate.update.resetDirty', { count }) }
    const listed = paths.slice(0, IN_THE_WAY_LISTED).join(', ') + (paths.length > IN_THE_WAY_LISTED ? ', …' : '')
    return { kind: 'error', message: text('integrate.update.resetInTheWay', { count, paths: listed }) }
  }
  return settle(outcome)
}

/** Notice naming the backup branch a reset-to-remote created. */
export function backupNotice(outcome: ActionOutcome<unknown>): ActionNotice | null {
  if (outcome.kind !== 'done') return null
  const branch = (outcome.value as Partial<ResetToRemoteValue> | null)?.backupBranch
  return typeof branch === 'string' ? { tone: 'warning', message: text('integrate.notice.backup', { branch }) } : null
}

export interface ResetForm {
  mode: ResetMode
  /** The user ticked the hard-reset risk checkbox (never remembered). */
  hardConfirmed: boolean
}

export function resetCanSubmit(form: ResetForm, preview: ResetPreviewValue | null): boolean {
  if (preview === null) return false
  return form.mode !== 'hard' || form.hardConfirmed
}

/** Reset to `sha`; `expectedHead` is the HEAD the user saw in the preview. */
export async function submitReset(
  deps: IntegrateDeps,
  form: ResetForm & { sha: string },
  preview: ResetPreviewValue | null,
): Promise<IntegrateResult> {
  if (preview === null || !resetCanSubmit(form, preview)) return { kind: 'stay' }
  const base = { sha: form.sha, mode: form.mode, expectedHead: preview.head }
  const payload = form.mode === 'hard' ? { ...base, confirmHard: true as const } : base
  const outcome = await deps.actions.run('reset', payload, { trigger: deps.trigger })
  const result = settle(outcome)
  if (result.kind === 'error' && outcome.kind === 'failed') {
    const stale = outcome.error.code === 'git/stale-target' && outcome.error.details?.['target'] === 'head'
    return stale ? { ...result, stale: true } : result
  }
  return result
}

export async function submitFetch(deps: IntegrateDeps, form: { remote: string | null; prune: boolean }): Promise<IntegrateResult> {
  return settle(await deps.actions.run('fetch', { remote: form.remote, prune: form.prune }, { trigger: deps.trigger }))
}

/** "Updated N refs" (or the fallbacks when the Git version cannot tell). */
export function fetchNotice(value: Partial<FetchValue>): LocalizedText {
  if (value.updatedRefs === undefined) return text('integrate.fetch.done')
  return value.updatedRefs === 0 ? text('integrate.fetch.upToDate') : text('integrate.fetch.updated', { count: value.updatedRefs })
}
