// Stash write actions (design §8.4, plan A3 T10): what is sent — always by sha, never by index —
// and how an outcome maps to a notice. React-free.
import type { StashCreateRequest } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import type { ActionNotice } from './branch-actions.ts'
import type { IntegrateResult } from './integrate-actions.ts'

export interface StashDeps {
  actions: Pick<ActionStore, 'run'>
  /** The control the user clicked (the conflict list opened by a conflict returns focus to it). */
  trigger: FocusTarget | null
}

export interface StashCreateForm {
  message: string
  includeUntracked: boolean
  keepIndex: boolean
}

/** A blank message is left out so the Host writes its default (`WIP on <branch>: …`). */
export function stashCreateRequest(form: StashCreateForm): Omit<StashCreateRequest, 'sessionId' | 'requestId'> {
  const message = form.message.trim()
  return {
    ...(message === '' ? {} : { message }),
    includeUntracked: form.includeUntracked,
    keepIndex: form.keepIndex,
  }
}

export async function submitStashCreate(deps: StashDeps, form: StashCreateForm): Promise<IntegrateResult> {
  const outcome = await deps.actions.run('stashCreate', stashCreateRequest(form), { trigger: deps.trigger })
  switch (outcome.kind) {
    case 'done':
    case 'conflict':
      return { kind: 'closed', outcome }
    case 'cancelled':
      return { kind: 'stay' }
    case 'failed':
      if (outcome.error.code === 'git/invalid-payload' && outcome.error.details?.['reason'] === 'nothing-to-stash') {
        return { kind: 'error', message: text('stash.nothing') }
      }
      return { kind: 'error', message: outcome.message }
  }
}

/** Apply keeps the stash; pop applies and removes it. */
export function applyStash(deps: StashDeps, sha: string, pop: boolean): Promise<ActionOutcome<unknown>> {
  return deps.actions.run('stashApply', { sha, pop }, { trigger: deps.trigger })
}

export function dropStash(deps: StashDeps, sha: string): Promise<ActionOutcome<unknown>> {
  return deps.actions.run('stashDrop', { sha }, { trigger: deps.trigger })
}

export interface StashEffect {
  notice: ActionNotice | null
  /** Reload the stash list. */
  refresh: boolean
}

/** What the page tells the user and whether it reloads the list after an apply / pop / drop. */
export function stashOutcomeEffect(outcome: ActionOutcome<unknown>): StashEffect {
  switch (outcome.kind) {
    case 'cancelled':
      return { notice: null, refresh: false }
    case 'done':
      return { notice: null, refresh: true }
    // The action store has already opened the conflict list; the stash is never dropped on a conflict.
    case 'conflict':
      return { notice: { tone: 'warning', message: text('stash.notice.conflictKept') }, refresh: true }
    case 'failed':
      if (outcome.error.code === 'git/stale-target') {
        return { notice: { tone: 'warning', message: text('stash.notice.changed') }, refresh: true }
      }
      return { notice: { tone: 'error', message: outcome.message }, refresh: false }
  }
}
