// File history (plan B2 T3, design §9.6): the commits that changed one file, following renames.
// - `log --follow -M --raw --numstat -z`; each record is `\x1e<log record>\n<raw/numstat tokens>`, so the
//   commit part reuses log.ts's record format and the change part reuses commit.ts's raw parser.
// - Each entry carries the path the file had in that commit: a rename entry switches the older
//   entries to its `origPath`, so a pre-rename diff asks for the path that existed then.
// - Paging reuses the v1 log cursor (`v1:<headSha>:<offset>`): the head is pinned on the first page.

import type { FileHistoryEntry, FileHistoryRequest, FileHistoryValue } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { parseRawNumstat } from './commit.ts'
import { validateRepoPath } from './diff.ts'
import { LOG_RECORD_FORMAT, encodeLogCursor, normalizeLogLimit, parseLogCursor, parseLogRecord } from './log.ts'
import { resolveRevision } from './revision.ts'
import { invalidPayload } from './write-support.ts'

const RECORD_START = '\u001e'
const HISTORY_STDOUT_MAX_BYTES = 16 * 1024 * 1024

export interface ReadFileHistoryOptions {
  signal?: AbortSignal | undefined
}

/** One page of the history of `request.path`, newest first. */
export async function readFileHistory(
  run: GitRunner,
  cwd: string,
  request: FileHistoryRequest,
  options: ReadFileHistoryOptions = {},
): Promise<FileHistoryValue> {
  const { signal } = options
  const path = validateRepoPath(request.path)
  const limit = normalizeLogLimit(request.limit)
  const start = await startOf(run, cwd, request, signal)
  if (start === null) return { path, entries: [], followedRename: false, truncated: false }

  const result = await run(
    [
      ...GIT_BASE_ARGV, 'log', '--follow', '-M', '--no-ext-diff', '--no-textconv', '--no-show-signature',
      '--raw', '--numstat', '--no-abbrev', '-z',
      `--max-count=${String(limit + 1)}`, `--skip=${String(start.offset)}`,
      `--pretty=format:${RECORD_START}${LOG_RECORD_FORMAT}`, start.head, '--', path,
    ],
    { cwd, signal, stdoutMaxBytes: HISTORY_STDOUT_MAX_BYTES },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git log --follow')

  const records = result.stdout.split(RECORD_START).slice(1)
  const entries: FileHistoryEntry[] = []
  let current = path
  for (const record of records.slice(0, limit)) {
    const entry = entryOf(record, current)
    entries.push(entry)
    if (entry.origPath !== undefined && entry.status === 'R') current = entry.origPath
  }
  const value: FileHistoryValue = {
    path,
    entries,
    followedRename: entries.some(entry => entry.status === 'R' && entry.origPath !== undefined),
    truncated: false,
  }
  if (records.length > limit) value.next = encodeLogCursor(start.head, start.offset + limit)
  return value
}

/** The pinned head and offset: from the cursor, else the requested revision (default HEAD). */
async function startOf(
  run: GitRunner,
  cwd: string,
  request: FileHistoryRequest,
  signal: AbortSignal | undefined,
): Promise<{ head: string; offset: number } | null> {
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string') throw invalidPayload('cursor must be a string', {})
    const { head, offset } = parseLogCursor(request.cursor)
    return { head: await resolveRevision(run, cwd, head, 'cursor', signal), offset }
  }
  if (request.rev !== undefined) return { head: await resolveRevision(run, cwd, request.rev, 'rev', signal), offset: 0 }
  // An unborn HEAD has no history yet.
  const head = await run([...GIT_BASE_ARGV, 'rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd, signal })
  if (head.exitCode !== 0) return null
  return { head: head.stdout.trim(), offset: 0 }
}

function entryOf(record: string, currentPath: string): FileHistoryEntry {
  const newline = record.indexOf('\n')
  const header = (newline === -1 ? record : record.slice(0, newline)).replace(/\0+$/u, '')
  const commit = parseLogRecord(header)
  const change = newline === -1 ? undefined : parseRawNumstat(record.slice(newline + 1))[0]
  // A merge kept by history simplification has no raw record: the file keeps its newer path.
  if (change === undefined) return { ...commit, path: currentPath, status: 'M' }
  const entry: FileHistoryEntry = { ...commit, path: change.path, status: change.status }
  if (change.origPath !== undefined) entry.origPath = change.origPath
  if (change.additions !== undefined) entry.additions = change.additions
  if (change.deletions !== undefined) entry.deletions = change.deletions
  if (change.binary) entry.binary = true
  return entry
}
