// Tags (plan b3b): create a lightweight or annotated tag on a commit from the log menu.
import type { CreateTagValue, TagDeleteValue, TagPushValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { networkFailure } from './push.ts'
import { parseRemoteName } from './remote-write.ts'
import { invalidPayload, parseCommitMessage, parseRefName, payloadRecord, query, readRemotes, redactedFailure } from './write-support.ts'

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

async function assertTag(ctx: Parameters<typeof createTagOperation.run>[0], name: string): Promise<void> {
  if ((await query(ctx, ['rev-parse', '-q', '--verify', `refs/tags/${name}`])).exitCode !== 0) {
    throw new GitCommandFailure('git/stale-target', `tag "${name}" does not exist`, { target: 'tag', name })
  }
}

async function assertRemote(ctx: Parameters<typeof createTagOperation.run>[0], remote: string): Promise<void> {
  if (!(await readRemotes(ctx)).includes(remote)) throw invalidPayload(`unknown remote "${remote}"`, { remote })
}

/** B3d: push one tag to a remote. */
export const tagPushOperation: WriteOperation<{ name: string; remote: string }, Omit<TagPushValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { name: parseRefName(record.name, 'name'), remote: parseRemoteName(record.remote, 'remote') }
  },

  async run(ctx, input) {
    await assertTag(ctx, input.name)
    await assertRemote(ctx, input.remote)
    const ref = `refs/tags/${input.name}`
    const result = await ctx.git([...GIT_BASE_ARGV, 'push', '--porcelain', '--', input.remote, `${ref}:${ref}`], { mode: 'network' })
    if (result.exitCode !== 0) throw networkFailure(result, ctx.repoRoot, ['push', input.remote, ref], 'git push')
    return { name: input.name, remote: input.remote }
  },
}

/**
 * B3d: delete a tag locally and, when asked, on one remote. The remote goes first: if it fails the
 * local tag is still there, so the failure is visible and the user can simply retry.
 */
export const tagDeleteOperation: WriteOperation<{ name: string; remote: string | undefined }, Omit<TagDeleteValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { name: parseRefName(record.name, 'name'), remote: record.remote === undefined ? undefined : parseRemoteName(record.remote, 'remote') }
  },

  async run(ctx, input) {
    await assertTag(ctx, input.name)
    let remoteDeleted = false
    if (input.remote !== undefined) {
      await assertRemote(ctx, input.remote)
      const ref = `:refs/tags/${input.name}`
      const remote = await ctx.git([...GIT_BASE_ARGV, 'push', '--porcelain', '--', input.remote, ref], { mode: 'network' })
      if (remote.exitCode !== 0) throw networkFailure(remote, ctx.repoRoot, ['push', input.remote, ref], 'git push')
      remoteDeleted = true
    }
    const local = await ctx.git([...GIT_BASE_ARGV, 'tag', '-d', input.name])
    if (local.exitCode !== 0) throw redactedFailure(local, 'git tag -d')
    return { name: input.name, localDeleted: true, remoteDeleted }
  },
}
