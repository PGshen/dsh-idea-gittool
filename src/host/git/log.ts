// log 分页读取（可行性调研 §6.3）：
// - `--max-count` 控制体量，绝不靠超时兜底；
// - `--pretty=format` + 稳定分隔符，字段按位置解析，主题是"剩余部分"；
// - 游标 `v1:<headSha>:<offset>` 钉住第一页的 head，翻页途中新提交不会造成重复/漏项。

import type { CommitSummary, LogValue } from '../../shared/protocol.ts'
import { LOG_PAGE_DEFAULT_LIMIT, LOG_PAGE_MAX_LIMIT } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'

/** ASCII unit separator: safe for every field except the subject, which is the remainder. */
const FIELD_SEPARATOR = '\u001f'
const FIELD_COUNT = 7
const PRETTY_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s'].join(FIELD_SEPARATOR)
const CURSOR_PATTERN = /^v1:([0-9a-f]{4,64}):(\d{1,9})$/
const CURSOR_MAX_OFFSET = 10_000_000

/** One page request: cursor is opaque and comes straight back from the previous `next`. */
export interface LogQuery {
  cursor?: string | undefined
  limit?: number | undefined
}

/** Cancellation and defaults for one page read. */
export interface ReadLogOptions {
  signal?: AbortSignal | undefined
  /** Test seam; defaults to {@link LOG_PAGE_DEFAULT_LIMIT}. */
  defaultLimit?: number | undefined
}

/** Build the opaque cursor for the next page. */
export function encodeLogCursor(head: string, offset: number): string {
  return `v1:${head}:${offset}`
}

/** Decode a cursor; anything outside the grammar is an invalid payload, not a stale repo. */
export function parseLogCursor(cursor: string): { head: string; offset: number } {
  const match = CURSOR_PATTERN.exec(cursor)
  const head = match?.[1]
  const digits = match?.[2]
  if (head === undefined || digits === undefined) {
    throw invalidPayload('log cursor is not a v1 cursor', { cursor: cursor.slice(0, 100) })
  }
  const offset = Number(digits)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CURSOR_MAX_OFFSET) {
    throw invalidPayload('log cursor offset is out of range', { offset })
  }
  return { head, offset }
}

/** Read one page of commits, newest first. */
export async function readLog(
  run: GitRunner,
  cwd: string,
  query: LogQuery,
  options: ReadLogOptions = {},
): Promise<LogValue> {
  const limit = normalizeLimit(query.limit, options.defaultLimit ?? LOG_PAGE_DEFAULT_LIMIT)

  let head: string
  let offset = 0
  if (query.cursor !== undefined) {
    const parsed = parseLogCursor(query.cursor)
    head = parsed.head
    offset = parsed.offset
    const verified = await run(['rev-parse', '--verify', `${head}^{commit}`], {
      cwd,
      signal: options.signal,
    })
    if (verified.exitCode !== 0) {
      throw invalidPayload('log cursor points at a commit that no longer exists', {
        cursor: query.cursor,
      })
    }
  } else {
    const resolved = await run(['rev-parse', '--verify', 'HEAD'], { cwd, signal: options.signal })
    // An unborn HEAD is an empty history, not an error.
    if (resolved.exitCode !== 0) return { commits: [], truncated: false }
    head = resolved.stdout.trim()
    if (head === '') return { commits: [], truncated: false }
  }

  const result = await run(
    [
      ...GIT_BASE_ARGV,
      'log',
      // Repository config must not spawn external diff drivers (可行性调研 §8.3).
      '--no-ext-diff',
      `--max-count=${String(limit + 1)}`,
      `--skip=${String(offset)}`,
      `--pretty=format:${PRETTY_FORMAT}`,
      head,
      '--',
    ],
    { cwd, signal: options.signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git log')

  const records = result.stdout.split('\n').filter((line) => line !== '')
  const commits = records.map(parseCommitRecord)
  const hasMore = commits.length > limit
  const page = hasMore ? commits.slice(0, limit) : commits
  const value: LogValue = { commits: page, truncated: hasMore }
  if (hasMore) value.next = encodeLogCursor(head, offset + page.length)
  return value
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return clampLimit(fallback)
  if (!Number.isInteger(limit) || limit < 1) {
    throw invalidPayload('log limit must be a positive integer', { limit })
  }
  return clampLimit(limit)
}

function clampLimit(limit: number): number {
  return Math.min(limit, LOG_PAGE_MAX_LIMIT)
}

function parseCommitRecord(line: string): CommitSummary {
  const parts = line.split(FIELD_SEPARATOR)
  if (parts.length < FIELD_COUNT) throw unparseable(line)
  const sha = parts[0]
  const shortSha = parts[1]
  const parents = parts[2]
  const author = parts[3]
  const email = parts[4]
  const date = parts[5]
  if (
    sha === undefined ||
    shortSha === undefined ||
    parents === undefined ||
    author === undefined ||
    email === undefined ||
    date === undefined
  ) {
    throw unparseable(line)
  }
  return {
    sha,
    shortSha,
    parents: parents === '' ? [] : parents.split(' '),
    author,
    email,
    date,
    // The subject is the remainder: a `\u001f` inside it must survive parsing.
    subject: parts.slice(FIELD_COUNT - 1).join(FIELD_SEPARATOR),
  }
}

function invalidPayload(message: string, details?: Record<string, unknown>): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}

function unparseable(line: string): GitCommandFailure {
  return new GitCommandFailure('git/exec-failed', 'unparseable git log record', {
    record: line.slice(0, 200),
  })
}
