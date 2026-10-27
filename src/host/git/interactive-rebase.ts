// Interactive rebase write endpoint (plan b3a): the client sends the whole todo as entries, the Host
// drives `git rebase -i` with `GIT_SEQUENCE_EDITOR='cat >'` and the todo on stdin; rewritten messages
// travel as blobs and are written back by `exec` lines (references/git-behavior §4).
import type { InteractiveRebaseValue, RebaseAction, RebaseEntry } from '../../shared/protocol.ts'
import { REBASE_ACTIONS, REBASE_PLAN_MAX_COMMITS } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { invalidPayload, optionalBoolean, parseCommitMessage, payloadRecord } from './write-support.ts'

export interface InteractiveRebaseInput {
  /** Full sha of the base, or null to rebase from the root. */
  base: string | null
  /** HEAD sha the client planned against; a moved HEAD is `git/stale-target`. */
  head: string
  entries: RebaseEntry[]
  updateRefs: boolean
  stash: boolean
}

function parseAction(value: unknown, index: number): RebaseAction {
  if (typeof value !== 'string' || !(REBASE_ACTIONS as readonly string[]).includes(value)) {
    throw invalidPayload(`entries[${String(index)}].action must be one of ${REBASE_ACTIONS.join(', ')}`)
  }
  return value as RebaseAction
}

function parseEntry(value: unknown, index: number): RebaseEntry {
  if (typeof value !== 'object' || value === null) throw invalidPayload(`entries[${String(index)}] must be an object`)
  const record = value as Record<string, unknown>
  const entry: RebaseEntry = {
    sha: parseFullSha(record.sha, `entries[${String(index)}].sha`),
    action: parseAction(record.action, index),
  }
  if (record.message !== undefined) entry.message = parseCommitMessage(record.message)
  else if (entry.action === 'reword') throw invalidPayload(`entries[${String(index)}]: reword needs a message`)
  return entry
}

function parseEntries(value: unknown): RebaseEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidPayload('entries must be a non-empty array')
  if (value.length > REBASE_PLAN_MAX_COMMITS) {
    throw invalidPayload(`entries exceed ${String(REBASE_PLAN_MAX_COMMITS)}`, { limit: REBASE_PLAN_MAX_COMMITS })
  }
  const entries = value.map(parseEntry)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.sha)) throw invalidPayload('entries must not repeat a commit', { sha: entry.sha })
    seen.add(entry.sha)
  }
  return entries
}

export const interactiveRebaseOperation: WriteOperation<
  InteractiveRebaseInput,
  Omit<InteractiveRebaseValue, 'version'>
> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      base: record.base === null ? null : parseFullSha(record.base, 'base'),
      head: parseFullSha(record.head, 'head'),
      entries: parseEntries(record.entries),
      updateRefs: optionalBoolean(record, 'updateRefs'),
      stash: optionalBoolean(record, 'stash'),
    }
  },

  run() {
    return Promise.reject(new GitCommandFailure('git/exec-failed', 'not implemented', {}))
  },
}
