// Fixup / Squash into (plan b3b): commit the chosen paths as `fixup! <subject>` / `squash! <subject>`
// of an older commit, then autosquash-rebase from its parent with the interactive rebase machinery.
import type { InteractiveRebaseValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { invalidPayload, optionalBoolean, parseCommitMessage, parseWritePaths, payloadRecord } from './write-support.ts'

export interface FixupCommitInput {
  target: string
  paths: string[]
  kind: 'fixup' | 'squash'
  message: string | undefined
  stash: boolean
}

export const fixupCommitOperation: WriteOperation<FixupCommitInput, Omit<InteractiveRebaseValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (record.kind !== 'fixup' && record.kind !== 'squash') throw invalidPayload('kind must be fixup or squash')
    return {
      target: parseFullSha(record.target, 'target'),
      paths: parseWritePaths(record.paths),
      kind: record.kind,
      message: record.message === undefined || record.message === '' ? undefined : parseCommitMessage(record.message),
      stash: optionalBoolean(record, 'stash'),
    }
  },

  run() {
    return Promise.reject(new GitCommandFailure('git/exec-failed', 'not implemented', {}))
  },
}
