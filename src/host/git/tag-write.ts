// Tags (plan b3b): create a lightweight or annotated tag on a commit from the log menu.
import type { CreateTagValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { invalidPayload, parseCommitMessage, parseRefName, payloadRecord, query, redactedFailure } from './write-support.ts'

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

  async run(ctx, input) {
    const ref = `refs/tags/${input.name}`
    if ((await query(ctx, ['check-ref-format', ref])).exitCode !== 0) {
      throw invalidPayload(`"${input.name}" is not a valid tag name`, { name: input.name })
    }
    if ((await query(ctx, ['rev-parse', '-q', '--verify', ref])).exitCode === 0) {
      throw new GitCommandFailure('git/branch-exists', `tag "${input.name}" already exists`, { kind: 'tag', branch: input.name })
    }
    const annotated = input.message === undefined ? [] : ['-a', '-F', '-']
    const result = await ctx.git(
      [...GIT_BASE_ARGV, 'tag', ...annotated, '--end-of-options', input.name, input.target],
      input.message === undefined ? {} : { stdin: input.message },
    )
    if (result.exitCode !== 0) throw redactedFailure(result, 'git tag')
    return { name: input.name, target: input.target }
  },
}
