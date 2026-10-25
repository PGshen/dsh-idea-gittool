// log 分页读取（可行性调研 §6.3；A1 追加筛选）：
// - `--max-count` 控制体量，绝不靠超时兜底；
// - `-z` + `--pretty=format` + 稳定分隔符，字段按位置解析，主题/正文是"剩余部分"；
// - 游标钉住第一页解析出的 head（一个或多个 sha），翻页途中新提交不会造成重复/漏项：
//   - 无筛选、只看 HEAD：`v1:<headSha>:<offset>`（M0 兼容格式）；
//   - 其余：`v2:<sha>[.<sha>…]:<offset>:<sig>`，sig 是筛选条件的签名，筛选变了旧游标即失效。
// - 结构性筛选（分支/作者/排序/第一父/无合并）交给 git；文本/哈希搜索由 Host 在 git 输出上匹配：
//   消息（主题+正文）、作者名、作者邮箱任一命中即可；形如哈希的 query 另按 sha 前缀命中。
//   搜索时 offset 记录的是"未经搜索过滤的流"中的位置，按块扫描直到凑满一页或用完扫描预算。

import { createHash } from 'node:crypto'

import type { CommitSummary, LogValue } from '../../shared/protocol.ts'
import { LOG_PAGE_DEFAULT_LIMIT, LOG_PAGE_MAX_LIMIT } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import type { RegexBatchMatcher } from './regex-worker.ts'
import { createRegexBatchMatcher } from './regex-worker.ts'

/** ASCII unit separator: safe for every field except the subject/message, which is the remainder. */
const FIELD_SEPARATOR = '\u001f'
const HEADER_FIELDS = ['%H', '%h', '%P', '%an', '%ae', '%aI']
const FIELD_COUNT = HEADER_FIELDS.length + 1
const PRETTY_FORMAT = [...HEADER_FIELDS, '%s'].join(FIELD_SEPARATOR)
/** Search mode reads the whole message; the subject is derived from it. */
const SEARCH_FORMAT = [...HEADER_FIELDS, '%B'].join(FIELD_SEPARATOR)
const CURSOR_V1_PATTERN = /^v1:([0-9a-f]{4,64}):(\d{1,9})$/
const CURSOR_V2_PATTERN = /^v2:([0-9a-f]{4,64}(?:\.[0-9a-f]{4,64}){0,63}):(\d{1,9}):([0-9a-f]{16})$/
const CURSOR_MAX_OFFSET = 10_000_000
const HASH_QUERY = /^[0-9a-fA-F]{4,64}$/

/** Filter bounds: keep pathological payloads out of argv and the matcher. */
export const LOG_QUERY_MAX_LENGTH = 200
export const LOG_MAX_BRANCHES = 32
export const LOG_MAX_AUTHORS = 32
const NAME_MAX_LENGTH = 256
/** Raw commits fetched per search chunk, and the most scanned per request. */
export const LOG_SEARCH_CHUNK = 2000
export const LOG_SEARCH_BUDGET = 20_000

/** One page request: cursor is opaque and comes straight back from the previous `next`. */
export interface LogQuery {
  cursor?: string | undefined
  limit?: number | undefined
  query?: string | undefined
  regex?: boolean | undefined
  caseSensitive?: boolean | undefined
  branches?: string[] | undefined
  authors?: string[] | undefined
  order?: 'date' | 'topo' | undefined
  firstParent?: boolean | undefined
  noMerges?: boolean | undefined
}

/** The filter part of a {@link LogQuery}, normalized (defaults dropped). */
export interface LogFilters {
  query?: string
  regex?: boolean
  caseSensitive?: boolean
  branches?: string[]
  authors?: string[]
  order?: 'topo'
  firstParent?: boolean
  noMerges?: boolean
}

/** Cancellation and defaults for one page read. */
export interface ReadLogOptions {
  signal?: AbortSignal | undefined
  /** Test seam; defaults to {@link LOG_PAGE_DEFAULT_LIMIT}. */
  defaultLimit?: number | undefined
  /** Test seams for the search scan. */
  searchChunk?: number | undefined
  searchBudget?: number | undefined
  /** Per-batch deadline for regex matching in the worker (test seam). */
  regexTimeoutMs?: number | undefined
}

/** Build the opaque v1 cursor (no filters, HEAD only). */
export function encodeLogCursor(head: string, offset: number): string {
  return `v1:${head}:${offset}`
}

/** Decode a v1 cursor; anything outside the grammar is an invalid payload, not a stale repo. */
export function parseLogCursor(cursor: string): { head: string; offset: number } {
  const match = CURSOR_V1_PATTERN.exec(cursor)
  const head = match?.[1]
  const digits = match?.[2]
  if (head === undefined || digits === undefined) {
    throw invalidPayload('log cursor is not a v1 cursor', { cursor: cursor.slice(0, 100) })
  }
  return { head, offset: parseOffset(digits) }
}

/** Decode a v1 or v2 cursor into pinned heads, offset and filter signature ('' for v1). */
export function parseAnyLogCursor(cursor: string): { heads: string[]; offset: number; signature: string } {
  if (cursor.startsWith('v1:')) {
    const { head, offset } = parseLogCursor(cursor)
    return { heads: [head], offset, signature: '' }
  }
  const match = CURSOR_V2_PATTERN.exec(cursor)
  const heads = match?.[1]
  const digits = match?.[2]
  const signature = match?.[3]
  if (heads === undefined || digits === undefined || signature === undefined) {
    throw invalidPayload('log cursor is not a valid cursor', { cursor: cursor.slice(0, 100) })
  }
  return { heads: heads.split('.'), offset: parseOffset(digits), signature }
}

/**
 * Validate and normalize the filter fields of an untrusted payload.
 * Type errors and out-of-bounds values are `git/invalid-payload`.
 */
export function normalizeLogFilters(input: Record<string, unknown>): LogFilters {
  const filters: LogFilters = {}
  const query = input.query
  if (query !== undefined) {
    if (typeof query !== 'string') throw invalidPayload('log query must be a string')
    if (query.length > LOG_QUERY_MAX_LENGTH) throw invalidPayload('log query is too long')
    if (query.trim() !== '') filters.query = query.trim()
  }
  for (const key of ['regex', 'caseSensitive', 'firstParent', 'noMerges'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw invalidPayload(`log ${key} must be a boolean`)
    if (value) filters[key] = true
  }
  if (filters.query === undefined) {
    // Matching flags without a query do not change the result; keep cache keys canonical.
    delete filters.regex
    delete filters.caseSensitive
  }
  const order = input.order
  if (order !== undefined && order !== 'date' && order !== 'topo') {
    throw invalidPayload('log order must be "date" or "topo"')
  }
  if (order === 'topo') filters.order = 'topo'
  const branches = stringList(input.branches, 'branches', LOG_MAX_BRANCHES)
  for (const branch of branches) {
    if (!isSafeRevisionName(branch)) throw invalidPayload('log branch is not a valid ref name', { branch })
  }
  if (branches.length > 0) filters.branches = [...new Set(branches)]
  const authors = stringList(input.authors, 'authors', LOG_MAX_AUTHORS)
  if (authors.length > 0) filters.authors = [...new Set(authors)]
  if (filters.query !== undefined && filters.regex === true) compileMatcher(filters)
  return filters
}

/** Stable signature of normalized filters; '' when there are none. */
export function logFilterSignature(filters: LogFilters): string {
  const canonical = JSON.stringify([
    filters.query ?? null,
    filters.regex === true,
    filters.caseSensitive === true,
    filters.branches ?? [],
    filters.authors ?? [],
    filters.order ?? 'date',
    filters.firstParent === true,
    filters.noMerges === true,
  ])
  if (canonical === JSON.stringify([null, false, false, [], [], 'date', false, false])) return ''
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** Read one page of commits, newest first. */
export async function readLog(
  run: GitRunner,
  cwd: string,
  query: LogQuery,
  options: ReadLogOptions = {},
): Promise<LogValue> {
  const limit = normalizeLimit(query.limit, options.defaultLimit ?? LOG_PAGE_DEFAULT_LIMIT)
  const filters = normalizeLogFilters(query as Record<string, unknown>)
  const signature = logFilterSignature(filters)
  const { signal } = options

  let heads: string[]
  let offset = 0
  if (query.cursor !== undefined) {
    const parsed = parseAnyLogCursor(query.cursor)
    if (cursorSignature(parsed.signature) !== cursorSignature(signature)) {
      throw invalidPayload('log cursor was issued for different filters', { cursor: query.cursor })
    }
    heads = parsed.heads
    offset = parsed.offset
    await verifyHeads(run, cwd, heads, query.cursor, signal)
  } else if (filters.branches !== undefined) {
    heads = await resolveBranches(run, cwd, filters.branches, signal)
  } else {
    const resolved = await run([...GIT_BASE_ARGV, 'rev-parse', '--verify', 'HEAD'], { cwd, signal })
    // An unborn HEAD is an empty history, not an error.
    if (resolved.exitCode !== 0) return { commits: [], truncated: false }
    const head = resolved.stdout.trim()
    if (head === '') return { commits: [], truncated: false }
    heads = [head]
  }

  const matcher = filters.query === undefined ? undefined : compileMatcher(filters, options.regexTimeoutMs)
  try {
    return await scanLog(run, cwd, heads, filters, signature, offset, limit, matcher, options)
  } finally {
    await matcher?.close()
  }
}

async function scanLog(
  run: GitRunner,
  cwd: string,
  heads: string[],
  filters: LogFilters,
  signature: string,
  offset: number,
  limit: number,
  matcher: BatchMatcher | undefined,
  options: ReadLogOptions,
): Promise<LogValue> {
  const { signal } = options
  let chunk = matcher === undefined ? limit + 1 : Math.max(limit + 1, options.searchChunk ?? LOG_SEARCH_CHUNK)
  const budget = options.searchBudget ?? LOG_SEARCH_BUDGET

  const matches: { commit: CommitSummary; position: number }[] = []
  let scanned = 0
  let exhausted = false
  while (matches.length <= limit) {
    let records: LogRecord[]
    try {
      records = await readChunk(run, cwd, heads, filters, offset + scanned, chunk, matcher !== undefined, signal)
    } catch (error) {
      // Long messages can overflow the executor's stdout cap: retry the same position smaller.
      if (error instanceof GitCommandFailure && error.code === 'git/output-too-large' && chunk > limit + 1) {
        chunk = Math.max(limit + 1, Math.floor(chunk / 2))
        continue
      }
      throw error
    }
    const hits = matcher === undefined ? undefined : await matcher.match(records)
    for (let index = 0; index < records.length && matches.length <= limit; index += 1) {
      const record = records[index]
      if (record === undefined) continue
      if (hits === undefined || hits[index] === true) {
        matches.push({ commit: record.commit, position: offset + scanned + index })
      }
    }
    scanned += records.length
    if (records.length < chunk) {
      exhausted = true
      break
    }
    if (matcher === undefined || scanned >= budget) break
  }

  const page = matches.slice(0, limit)
  const value: LogValue = { commits: page.map((match) => match.commit), truncated: false }
  let nextOffset: number | undefined
  if (matches.length > limit) {
    const last = page.at(-1)
    nextOffset = last === undefined ? offset : last.position + 1
  } else if (!exhausted) {
    // Search budget spent before a full page: continue scanning from where we stopped.
    nextOffset = offset + scanned
  }
  if (nextOffset !== undefined) {
    value.truncated = true
    value.next =
      signature === '' && heads.length === 1 && heads[0] !== undefined
        ? encodeLogCursor(heads[0], nextOffset)
        : `v2:${heads.join('.')}:${String(nextOffset)}:${cursorSignature(signature)}`
  }
  return value
}

/** Unfiltered reads encode an all-zero signature in v2 cursors; compare both sides normalized (评审 M6). */
const EMPTY_CURSOR_SIGNATURE = '0'.repeat(16)

function cursorSignature(signature: string): string {
  return signature === '' ? EMPTY_CURSOR_SIGNATURE : signature
}

interface LogRecord {
  commit: CommitSummary
  message: string
}

async function readChunk(
  run: GitRunner,
  cwd: string,
  heads: string[],
  filters: LogFilters,
  skip: number,
  count: number,
  withMessage: boolean,
  signal: AbortSignal | undefined,
): Promise<LogRecord[]> {
  const result = await run(
    [
      ...GIT_BASE_ARGV,
      'log',
      // Repository config must not spawn external diff drivers (可行性调研 §8.3).
      '--no-ext-diff',
      '--no-show-signature',
      '-z',
      filters.order === 'topo' ? '--topo-order' : '--date-order',
      ...(filters.firstParent === true ? ['--first-parent'] : []),
      ...(filters.noMerges === true ? ['--no-merges'] : []),
      // Author filters are literal substrings of "Name <email>"; several authors are OR'ed by git.
      ...(filters.authors === undefined
        ? []
        : ['--fixed-strings', ...filters.authors.map((author) => `--author=${author}`)]),
      `--max-count=${String(count)}`,
      `--skip=${String(skip)}`,
      `--pretty=format:${withMessage ? SEARCH_FORMAT : PRETTY_FORMAT}`,
      ...heads,
      '--',
    ],
    { cwd, signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git log')
  return result.stdout
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => parseCommitRecord(record, withMessage))
}

/** Resolve branch names to commit shas; an unknown name is an invalid payload. */
async function resolveBranches(
  run: GitRunner,
  cwd: string,
  branches: string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  // `rev-parse --verify` takes a single revision; resolve all names in one call without it.
  // Names are pre-validated (no leading '-', no range/revision syntax) and `--` ends the revisions.
  const resolved = await run([...GIT_BASE_ARGV, 'rev-parse', ...branches.map((name) => `${name}^{commit}`), '--'], {
    cwd,
    signal,
  })
  if (resolved.exitCode !== 0) {
    if (/not a git repository/i.test(resolved.stderr)) throw failureFromExit(resolved, 'git rev-parse')
    throw invalidPayload('log branch does not name a commit', { branches })
  }
  const shas = resolved.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40,64}$/.test(line))
  return [...new Set(shas)]
}

/** Every pinned head must still exist; otherwise the cursor is stale. */
async function verifyHeads(
  run: GitRunner,
  cwd: string,
  heads: string[],
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const argv =
    heads.length === 1
      ? [...GIT_BASE_ARGV, 'rev-parse', '--verify', `${heads[0] ?? ''}^{commit}`]
      : [...GIT_BASE_ARGV, 'rev-parse', ...heads.map((head) => `${head}^{commit}`), '--']
  const verified = await run(argv, { cwd, signal })
  if (verified.exitCode !== 0) {
    throw invalidPayload('log cursor points at a commit that no longer exists', { cursor })
  }
}

interface BatchMatcher {
  match: (records: readonly LogRecord[]) => Promise<boolean[]>
  close: () => Promise<void>
}

/**
 * Build the text/hash matcher: message, author name, author email; hash-shaped → sha prefix too.
 * Literal queries match on the main thread; regex queries match in a worker with a deadline
 * (a user pattern must never be able to block the Host event loop, 评审 I2).
 */
function compileMatcher(filters: LogFilters, regexTimeoutMs?: number): BatchMatcher {
  const query = filters.query ?? ''
  const caseSensitive = filters.caseSensitive === true
  const hashPrefix = HASH_QUERY.test(query) ? query.toLowerCase() : undefined
  const hashHit = (record: LogRecord): boolean => hashPrefix !== undefined && record.commit.sha.startsWith(hashPrefix)
  const textsOf = (record: LogRecord): string[] => [record.message, record.commit.author, record.commit.email]

  if (filters.regex === true) {
    const flags = caseSensitive ? 'mu' : 'imu'
    // Compiling is linear and safe on the main thread; it also yields the syntax error early.
    try {
      new RegExp(query, flags)
    } catch (error) {
      throw invalidPayload('log query is not a valid regular expression', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    let worker: RegexBatchMatcher | undefined
    return {
      match: async (records) => {
        worker ??= createRegexBatchMatcher(query, flags, regexTimeoutMs)
        const hits = await worker.match(records.map(textsOf))
        return records.map((record, index) => hashHit(record) || hits[index] === true)
      },
      close: async () => {
        await worker?.close()
      },
    }
  }

  const needle = caseSensitive ? query : query.toLowerCase()
  const test = caseSensitive
    ? (text: string): boolean => text.includes(needle)
    : (text: string): boolean => text.toLowerCase().includes(needle)
  return {
    match: async (records) => records.map((record) => hashHit(record) || textsOf(record).some(test)),
    close: async () => {},
  }
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

function parseOffset(digits: string): number {
  const offset = Number(digits)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CURSOR_MAX_OFFSET) {
    throw invalidPayload('log cursor offset is out of range', { offset })
  }
  return offset
}

function stringList(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidPayload(`log ${label} must be an array of strings`)
  if (value.length > max) throw invalidPayload(`log ${label} has too many entries`, { max })
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > NAME_MAX_LENGTH) {
      throw invalidPayload(`log ${label} must be non-empty strings`)
    }
    list.push(item)
  }
  return list
}

/** A ref name that cannot be read as an option, range or revision expression. */
function isSafeRevisionName(name: string): boolean {
  if (name.startsWith('-') || name.includes('..') || name.includes('@{')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name)
}

/** Git's subject: the first paragraph of the message, lines joined by a space. */
function subjectOf(message: string): string {
  const paragraph = message.replace(/^\s*\n/, '').split(/\n\s*\n/)[0] ?? ''
  return paragraph
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .trim()
}

function parseCommitRecord(record: string, withMessage: boolean): LogRecord {
  const parts = record.split(FIELD_SEPARATOR)
  if (parts.length < FIELD_COUNT) throw unparseable(record)
  const [sha, shortSha, parents, author, email, date] = parts
  if (
    sha === undefined ||
    shortSha === undefined ||
    parents === undefined ||
    author === undefined ||
    email === undefined ||
    date === undefined
  ) {
    throw unparseable(record)
  }
  // The subject/message is the remainder: a `\u001f` inside it must survive parsing.
  const remainder = parts.slice(FIELD_COUNT - 1).join(FIELD_SEPARATOR)
  return {
    commit: {
      sha,
      shortSha,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      email,
      date,
      subject: withMessage ? subjectOf(remainder) : remainder,
    },
    message: withMessage ? remainder : '',
  }
}

function invalidPayload(message: string, details: Record<string, unknown> = {}): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}

function unparseable(record: string): GitCommandFailure {
  return new GitCommandFailure('git/exec-failed', 'unparseable git log record', {
    record: record.slice(0, 200),
  })
}
