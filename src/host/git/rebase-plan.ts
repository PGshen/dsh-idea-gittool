// Interactive rebase plan (plan b3a T2): the commits of `base..HEAD` (first parent, oldest first) with
// their full messages, whether a remote already has them, and the other local branches on them
// (`--update-refs`). A range the page cannot edit is answered with `blocked` and no commits.
// - `base` is resolved to a sha first (ADR 0010); only shas reach later git calls.
// - Merge commits anywhere in the range block it: the page has no `--rebase-merges`.

import type { RebaseBlockedReason, RebasePlanCommit, RebasePlanRequest, RebasePlanValue } from '../../shared/protocol.ts'
import { REBASE_PLAN_MAX_COMMITS } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { gitSupports, parseGitVersion } from '../git-version.ts'
import { resolveRevision } from './revision.ts'
import { invalidPayload } from './write-support.ts'

/** NUL-separated fields, NUL-separated records (`log -z`): a message cannot contain NUL (review M7). */
const PLAN_FIELDS = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%B']
const PLAN_FORMAT = PLAN_FIELDS.join('%x00')
const PLAN_STDOUT_MAX_BYTES = 16 * 1024 * 1024
export interface ReadRebasePlanOptions {
  signal?: AbortSignal | undefined
  /** `git --version` number (`2.50.1`); undefined → `--update-refs` treated as unsupported. */
  gitVersion?: string | undefined
}

/** Whether `version` (`2.50.1`, `2.38.0.windows.1`) has `rebase --update-refs` (2.38). */
export function supportsUpdateRefs(version: string | undefined): boolean {
  const parsed = parseGitVersion(version ?? '')
  return parsed !== null && gitSupports(parsed, 'updateRefs')
}

export async function readRebasePlan(
  run: GitRunner,
  cwd: string,
  request: RebasePlanRequest,
  options: ReadRebasePlanOptions = {},
): Promise<RebasePlanValue> {
  const { signal } = options
  const git = async (args: readonly string[], stdoutMaxBytes?: number): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], { cwd, signal, ...(stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes }) })
  const ok = async (args: readonly string[], label: string, stdoutMaxBytes?: number): Promise<string> => {
    const result = await git(args, stdoutMaxBytes)
    if (result.exitCode !== 0) throw failureFromExit(result, label)
    return result.stdout
  }

  if (request.base !== null && typeof request.base !== 'string') throw invalidPayload('base must be a revision or null', {})
  const base = request.base === null ? null : await resolveRevision(run, cwd, request.base, 'base', signal)
  const head = (await ok(['rev-parse', '--verify', 'HEAD'], 'git rev-parse')).trim()
  // Full ref names: a tag with the same name makes `--short` print `heads/<name>` (review I1).
  const symbolic = await git(['symbolic-ref', '-q', 'HEAD'])
  const branch = symbolic.exitCode === 0 ? stripHeads(symbolic.stdout.trim()) : ''
  const value: RebasePlanValue = { base, head, branch, commits: [], supportsUpdateRefs: supportsUpdateRefs(options.gitVersion) }
  const blocked = (reason: RebaseBlockedReason): RebasePlanValue => ({ ...value, blocked: reason })

  if (branch === '') return blocked('detached')
  if (base === head) return blocked('empty')
  if (base !== null) {
    const ancestor = await git(['merge-base', '--is-ancestor', base, head])
    if (ancestor.exitCode === 1) return blocked('not-ancestor')
    if (ancestor.exitCode !== 0) throw failureFromExit(ancestor, 'git merge-base')
  }
  const range = base === null ? [head] : [`${base}..${head}`]
  const merges = Number((await ok(['rev-list', '--count', '--min-parents=2', ...range, '--'], 'git rev-list')).trim())
  if (merges > 0) return blocked('merge-commit')
  const count = Number((await ok(['rev-list', '--count', ...range, '--'], 'git rev-list')).trim())
  if (count > REBASE_PLAN_MAX_COMMITS) return blocked('too-many')

  const log = await ok(['log', '-z', '--reverse', `--format=${PLAN_FORMAT}`, ...range, '--'], 'git log', PLAN_STDOUT_MAX_BYTES)
  const unpushed = new Set(
    (await ok(['rev-list', ...range, '--not', '--remotes', '--'], 'git rev-list')).split('\n').filter(line => line !== ''),
  )
  const branches = await branchesBySha(ok, await checkedOutBranches(ok))
  value.commits = parseRecords(log).map(commit => ({
    ...commit,
    pushed: !unpushed.has(commit.sha),
    branches: branches.get(commit.sha) ?? [],
  }))
  return value
}

function stripHeads(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/**
 * Branches checked out in any worktree, the current one included. A hand-written `update-ref` line
 * would move them under that worktree's HEAD, which git's own `--update-refs` never does (review I2).
 */
async function checkedOutBranches(ok: (args: readonly string[], label: string) => Promise<string>): Promise<Set<string>> {
  const output = await ok(['worktree', 'list', '--porcelain'], 'git worktree list')
  return new Set(output.split('\n').filter(line => line.startsWith('branch ')).map(line => stripHeads(line.slice('branch '.length))))
}

/** Local branches by the sha they point at, sorted, without branches checked out in a worktree. */
async function branchesBySha(
  ok: (args: readonly string[], label: string) => Promise<string>,
  checkedOut: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const output = await ok(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], 'git for-each-ref')
  const map = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    const sha = line.slice(0, space)
    const name = stripHeads(line.slice(space + 1))
    if (checkedOut.has(name)) continue
    map.set(sha, [...(map.get(sha) ?? []), name].sort())
  }
  return map
}

function parseRecords(output: string): Omit<RebasePlanCommit, 'pushed' | 'branches'>[] {
  const commits: Omit<RebasePlanCommit, 'pushed' | 'branches'>[] = []
  const tokens = output.split('\0')
  for (let at = 0; at + PLAN_FIELDS.length <= tokens.length; at += PLAN_FIELDS.length) {
    const [sha = '', shortSha = '', parents = '', author = '', email = '', date = '', subject = '', message = ''] =
      tokens.slice(at, at + PLAN_FIELDS.length)
    const cleanSha = sha.replace(/^\n+/u, '')
    if (cleanSha === '') continue
    commits.push({
      sha: cleanSha,
      shortSha,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      email,
      date,
      subject,
      message: message.replace(/\n+$/u, ''),
    })
  }
  return commits
}
