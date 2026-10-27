// Compare mode (plan B2 T3, design §9.6): commits in `left` but not in `right` (`right..left`) and the
// files `left` changed since the merge base (`right...left`). `right: null` compares `left` with the
// worktree: files only (staged and unstaged together, untracked files excluded, like `git diff <rev>`).
// - Both revisions are resolved to shas first; the commit list pages with the v1 log cursor pinned to
//   the left sha, so a cursor of another comparison is refused.
// - Unrelated histories have no merge base; the file list then diffs the two revisions directly.

import type { CommitSummary, CompareRequest, CompareRev, CompareValue, FileEntry } from '../../shared/protocol.ts'
import { STATUS_ENTRY_LIMIT } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { parseRawNumstat } from './commit.ts'
import { mergeBaseOf } from './diff.ts'
import { LOG_RECORD_FORMAT, encodeLogCursor, normalizeLogLimit, parseLogCursor, parseLogRecord } from './log.ts'
import { resolveRevision } from './revision.ts'
import { invalidPayload } from './write-support.ts'

const COMPARE_STDOUT_MAX_BYTES = 16 * 1024 * 1024

export interface ReadCompareOptions {
  signal?: AbortSignal | undefined
}

/** One page of a comparison. */
export async function readCompare(
  run: GitRunner,
  cwd: string,
  request: CompareRequest,
  options: ReadCompareOptions = {},
): Promise<CompareValue> {
  const { signal } = options
  if (request.right === undefined) throw invalidPayload('right must be a revision or null', {})
  const left: CompareRev = { input: String(request.left), sha: await resolveRevision(run, cwd, request.left, 'left', signal) }
  const right: CompareRev | null = request.right === null
    ? null
    : { input: request.right, sha: await resolveRevision(run, cwd, request.right, 'right', signal) }
  const limit = normalizeLogLimit(request.limit)

  let offset = 0
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string') throw invalidPayload('cursor must be a string', {})
    const cursor = parseLogCursor(request.cursor)
    if (right === null || cursor.head !== left.sha) throw invalidPayload('cursor belongs to another comparison', {})
    offset = cursor.offset
  }

  const page = right === null ? { commits: [], more: false } : await commitsOf(run, cwd, left.sha, right.sha, offset, limit, signal)
  const base = right === null ? null : (await mergeBaseOf(run, cwd, right.sha, left.sha, signal)) ?? right.sha
  const files = await filesOf(run, cwd, base === null ? [left.sha] : [base, left.sha], signal)
  const value: CompareValue = { left, right, commits: page.commits, files: files.entries, filesTruncated: files.truncated }
  if (page.more) value.next = encodeLogCursor(left.sha, offset + limit)
  return value
}

async function commitsOf(
  run: GitRunner,
  cwd: string,
  left: string,
  right: string,
  offset: number,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ commits: CommitSummary[]; more: boolean }> {
  const result = await run(
    [
      ...GIT_BASE_ARGV, 'log', '--no-ext-diff', '--no-show-signature', '-z', '--date-order',
      `--max-count=${String(limit + 1)}`, `--skip=${String(offset)}`, `--pretty=format:${LOG_RECORD_FORMAT}`,
      left, `^${right}`, '--',
    ],
    { cwd, signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git log')
  const commits = result.stdout.split('\0').filter(record => record !== '').map(parseLogRecord)
  return { commits: commits.slice(0, limit), more: commits.length > limit }
}

async function filesOf(
  run: GitRunner,
  cwd: string,
  range: string[],
  signal: AbortSignal | undefined,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const result = await run(
    [
      ...GIT_BASE_ARGV, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-M',
      '--raw', '--numstat', '--no-abbrev', '-z', ...range, '--',
    ],
    { cwd, signal, stdoutMaxBytes: COMPARE_STDOUT_MAX_BYTES },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git diff --raw')
  const changes = parseRawNumstat(result.stdout)
  const entries = changes.slice(0, STATUS_ENTRY_LIMIT).map((change): FileEntry => {
    const entry: FileEntry = { path: change.path, status: change.status }
    if (change.origPath !== undefined) entry.origPath = change.origPath
    if (change.additions !== undefined) entry.additions = change.additions
    if (change.deletions !== undefined) entry.deletions = change.deletions
    return entry
  })
  return { entries, truncated: changes.length > STATUS_ENTRY_LIMIT }
}
