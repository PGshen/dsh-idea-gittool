// Fixup / Squash into (plan b3b): commit the chosen paths as `fixup! <subject>` / `squash! <subject>`
// of an older commit, then autosquash-rebase from its parent with the interactive rebase machinery.
import type { InteractiveRebaseValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV } from '../git-executor.ts'
import { commitFilesOperation } from './commit-write.ts'
import { parseFullSha } from './integrate.ts'
import { rebaseOutcome } from './interactive-rebase.ts'
import { readRebasePlan } from './rebase-plan.ts'
import { detectOperationIn } from './status.ts'
import { dirtyTrackedPaths, dirtyWorktree, withSmartStash, writeGitDir } from './smart-stash.ts'
import {
  assertNoOperation,
  invalidPayload,
  optionalBoolean,
  parseCommitMessage,
  parseWritePaths,
  payloadRecord,
  queryOk,
  readHead,
  readRunner,
} from './write-support.ts'

/** Same budget as the interactive rebase (plan b3a). */
const AUTOSQUASH_TIMEOUT_MS = 180_000

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

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const parents = (await queryOk(ctx, ['log', '-1', '--format=%P', input.target, '--'], 'git log')).trim().split(' ').filter(Boolean)
    if (parents.length > 1) throw invalidPayload('cannot fold changes into a merge commit', { reason: 'merge-commit' })
    const base = parents[0] ?? null
    const plan = await readRebasePlan(readRunner(ctx), ctx.repoRoot, { sessionId: '', base })
    const target = plan.commits.find(commit => commit.sha === input.target)
    if (plan.blocked !== undefined || target === undefined) {
      throw invalidPayload('the target is not on the current branch', { reason: plan.blocked ?? 'not-ancestor' })
    }
    // Autosquash folds every `fixup!`/`squash!`/`amend!` commit of the range, not only ours (review I3).
    if (plan.commits.some(commit => /^(?:fixup|squash|amend)! /u.test(commit.subject))) {
      throw invalidPayload('the branch already has fixup!/squash!/amend! commits after the target', { reason: 'pending-autosquash' })
    }
    // Changes outside the chosen paths would stop the autosquash: decide before committing anything,
    // so answering the stash question never creates a second fixup commit.
    const chosen = new Set(input.paths)
    const others = (await dirtyTrackedPaths(ctx)).filter(path => !chosen.has(path))
    if (others.length > 0 && !input.stash) throw dirtyWorktree(others, 'rebase')

    const extra = input.kind === 'squash' && input.message !== undefined ? `\n\n${input.message}` : ''
    const before = plan.head
    await commitFilesOperation.run(ctx, { paths: input.paths, message: `${input.kind}! ${target.subject}${extra}`, amend: false })
    const gitDir = await writeGitDir(ctx)
    const { value, outcome } = await withSmartStash(ctx, { stash: input.stash, operation: 'rebase' }, async () => {
      const result = await ctx.git(
        [
          ...GIT_BASE_ARGV,
          'rebase',
          '-i',
          '--autosquash',
          '--no-reschedule-failed-exec',
          ...(base === null ? ['--root'] : ['--end-of-options', base]),
        ],
        { timeoutMs: AUTOSQUASH_TIMEOUT_MS },
      )
      try {
        return await rebaseOutcome(ctx, gitDir, result)
      } catch (error) {
        // Nothing is in progress (refused by a hook, failed to start): take our commit back so a
        // retry does not stack a second one; the changes return to the index (review I4).
        if ((await detectOperationIn(gitDir)) === null) {
          await ctx.git([...GIT_BASE_ARGV, 'reset', '-q', '--soft', before, '--'])
        }
        throw error
      }
    })
    const response: Omit<InteractiveRebaseValue, 'version'> = { head: (await readHead(ctx)).sha, completed: !value.open, ...outcome }
    if (value.stop !== undefined) response.stop = value.stop
    return response
  },
}
