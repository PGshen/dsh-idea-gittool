// Interactive rebase write endpoint (plan b3a): the client sends the whole todo as entries, the Host
// drives `git rebase -i` with `GIT_SEQUENCE_EDITOR='cat >'` and the todo on stdin; rewritten messages
// travel as blobs and are written back by `exec` lines (references/git-behavior §4).
import type { InteractiveRebaseValue, RebaseAction, RebaseEntry, RebaseStop } from '../../shared/protocol.ts'
import { REBASE_ACTIONS, REBASE_PLAN_MAX_COMMITS } from '../../shared/protocol.ts'
import { buildTodo, rebaseTodoProblem } from '../../shared/rebase-todo.ts'
import type { GitRunResult, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { gitSupports } from '../git-version.ts'
import { REBASE_HOOKS, parseFullSha } from './integrate.ts'
import { unmergedCount } from './operation.ts'
import { readRebasePlan } from './rebase-plan.ts'
import { withSmartStash, writeGitDir } from './smart-stash.ts'
import { detectOperationIn, readRebaseStop } from './status.ts'
import {
  assertNoOperation,
  hasHook,
  invalidPayload,
  optionalBoolean,
  outputSummary,
  parseCommitMessage,
  payloadRecord,
  readHead,
  gitVersionOf,
  readRunner,
  redactedFailure,
} from './write-support.ts'

/** A long range with an exec per reworded commit can take a while; same budget as network commands. */
const INTERACTIVE_REBASE_TIMEOUT_MS = 180_000

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

  async run(ctx, input) {
    await assertNoOperation(ctx)
    // A git known to be older has no `--update-refs`: drop it rather than fail (B4d T1; the page hides
    // the option). An unreadable version lets git try, like requireGitFeature (final review M7).
    const version = await gitVersionOf(ctx)
    const plan = await readRebasePlan(readRunner(ctx), ctx.repoRoot, { sessionId: '', base: input.base })
    const updateRefs = input.updateRefs && (version === null || gitSupports(version, 'updateRefs'))
    if (plan.head !== input.head) {
      throw new GitCommandFailure('git/stale-target', 'HEAD moved since the rebase list was opened', {
        target: 'head',
        expected: input.head,
        actual: plan.head,
      })
    }
    if (plan.blocked !== undefined) throw invalidPayload(`this range cannot be rebased: ${plan.blocked}`, { reason: plan.blocked })
    const problem = rebaseTodoProblem(plan.commits.map(commit => commit.sha), input.entries)
    if (problem !== null) throw invalidPayload(`the rebase entries are invalid: ${problem}`, { reason: problem })
    const branches = new Map(plan.commits.map(commit => [commit.sha, commit.branches]))
    const gitDir = await writeGitDir(ctx)

    const { value, outcome } = await withSmartStash(ctx, { stash: input.stash, operation: 'rebase' }, async () => {
      const blobs = await storeMessages(ctx, input.entries)
      const todo = buildTodo(input.entries, {
        messageBlob: index => blobs.get(index) ?? '',
        branches: updateRefs ? sha => branches.get(sha) ?? [] : undefined,
      })
      const result = await ctx.git(
        [
          ...GIT_BASE_ARGV,
          'rebase',
          '-i',
          // Pin git-behavior §4 regardless of `rebase.rescheduleFailedExec` (review I3).
          '--no-reschedule-failed-exec',
          ...(updateRefs ? ['--update-refs'] : []),
          ...(input.base === null ? ['--root'] : ['--end-of-options', input.base]),
        ],
        { stdin: todo, todoFromStdin: true, timeoutMs: INTERACTIVE_REBASE_TIMEOUT_MS },
      )
      return await rebaseOutcome(ctx, gitDir, result)
    })
    const response: Omit<InteractiveRebaseValue, 'version'> = { head: (await readHead(ctx)).sha, completed: !value.open, ...outcome }
    if (value.stop !== undefined) response.stop = value.stop
    return response
  },
}

/**
 * Where a `rebase -i` run left the repository (B3a; shared with B3b fixup): open with a stop reason,
 * or finished. Never trusts the exit code alone: an `edit` stop exits 0 (references/git-behavior §4).
 */
export async function rebaseOutcome(
  ctx: WriteContext,
  gitDir: string,
  result: GitRunResult,
): Promise<{ open: boolean; stop: RebaseStop | undefined }> {
  if ((await detectOperationIn(gitDir)) === 'rebase') {
    const stop = await readRebaseStop(gitDir, await unmergedCount(ctx))
    if (stop === undefined && result.exitCode !== 0) {
      // Stopped for a reason the banner cannot name (e.g. a pick would overwrite untracked
      // files): keep git's words instead of closing the page silently (review M5).
      const failure = redactedFailure(result, 'git rebase -i')
      throw new GitCommandFailure(failure.code, failure.message, { ...failure.details, operation: 'rebase', output: outputSummary(result) })
    }
    return { open: true, stop }
  }
  if (result.exitCode !== 0) {
    if (await hasHook(ctx, REBASE_HOOKS)) {
      throw new GitCommandFailure('git/hook-failed', 'the rebase was blocked by a Git hook', {
        exitCode: result.exitCode,
        output: outputSummary(result),
      })
    }
    throw redactedFailure(result, 'git rebase -i')
  }
  return { open: false, stop: undefined }
}

/** Store each entry message as a blob; the todo's exec lines read them back by sha. */
async function storeMessages(ctx: WriteContext, entries: readonly RebaseEntry[]): Promise<Map<number, string>> {
  const blobs = new Map<number, string>()
  for (const [index, entry] of entries.entries()) {
    if (entry.message === undefined) continue
    const sha = (
      await queryOkWithStdin(ctx, ['hash-object', '-w', '--stdin'], entry.message)
    ).trim()
    blobs.set(index, sha)
  }
  return blobs
}

async function queryOkWithStdin(ctx: WriteContext, args: readonly string[], stdin: string): Promise<string> {
  const result = await ctx.git([...GIT_BASE_ARGV, ...args], { stdin })
  if (result.exitCode !== 0) throw redactedFailure(result, `git ${args[0] ?? ''}`)
  return result.stdout
}
