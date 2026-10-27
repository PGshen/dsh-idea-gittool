// Tags (plan b3b): create a lightweight or annotated tag on a commit from the log menu.
import type { CreateTagValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { parseCommitMessage, parseRefName, payloadRecord } from './write-support.ts'

export interface CreateTagInput {
  name: string
  target: string
  message: string | undefined
}

export const createTagOperation: WriteOperation<CreateTagInput, Omit<CreateTagValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      name: parseRefName(record.name, 'name'),
      target: parseFullSha(record.target, 'target'),
      message: record.message === undefined || record.message === '' ? undefined : parseCommitMessage(record.message),
    }
  },

  run() {
    return Promise.reject(new GitCommandFailure('git/exec-failed', 'not implemented', {}))
  },
}
