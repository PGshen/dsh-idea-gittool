// Stash write actions (design §8.4, plan A3 T10): what is sent — always by sha, never by index —
// and how an outcome maps to a notice. React-free.
import type { StashApplyValue, StashCreateRequest } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
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

/**
 * A successful apply / pop that did not do everything (final review 3): the popped entry could
 * not be dropped (popping again would apply it twice), or the staging area was not rebuilt.
 */
function partialApplyNotice(value: unknown, pop: boolean): ActionNotice | null {
  if (typeof value !== 'object' || value === null) return null
  const applied = value as Partial<StashApplyValue>
  const messages: LocalizedText[] = []
  if (pop && applied.dropped === false) messages.push(text('stash.notice.notDropped'))
  if (applied.indexRestored === false) messages.push(text('stash.notice.indexNotRestored'))
  const [message, detail] = messages
  if (message === undefined) return null
  return detail === undefined ? { tone: 'warning', message } : { tone: 'warning', message, detail }
}

/**
 * What the page tells the user and whether it reloads the list after an apply / pop / drop.
 * `pop`: the outcome is of a pop (its entry should be gone afterwards).
 */
export function stashOutcomeEffect(outcome: ActionOutcome<unknown>, pop = false): StashEffect {
  switch (outcome.kind) {
    case 'cancelled':
      return { notice: null, refresh: false }
    case 'done':
      return { notice: partialApplyNotice(outcome.value, pop), refresh: true }
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
