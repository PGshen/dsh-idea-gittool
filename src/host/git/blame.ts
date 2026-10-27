// Line-segment blame (plan B2 T2, design §9.6/§9.7):
// - `rev` is resolved to a full sha first (revision.ts); absent = the worktree content.
// - Size, binary and the line count come from the same content blame reads: the revision's blob
//   (`cat-file`) or the worktree file (worktree-read.ts guard). Over BLAME_MAX_BYTES → tooLarge with a
//   terminal command; NUL → binary. Untracked / missing files answer an empty value with `unavailable`.
// - One page = `blame --line-porcelain --root -L <start>,+<limit>`; `--root` keeps the root commit from
//   being reported as a boundary; a shallow clone's grafted edge is then marked from `.git/shallow`.
// - Uncommitted worktree lines carry the all-zero sha (porcelain's own spelling of "Not Committed Yet").

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { BlameCommit, BlameRequest, BlameSegment, BlameValue } from '../../shared/protocol.ts'
import { BLAME_MAX_BYTES, BLAME_PAGE_MAX_LINES } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { validateRepoPath } from './diff.ts'
import { resolveRevision } from './revision.ts'
import { readWorktreeFile } from './worktree-read.ts'
import { invalidPayload, shellQuote } from './write-support.ts'

/** `--line-porcelain` repeats every header per line; 2000 lines of long text stay well under this. */
const BLAME_STDOUT_MAX_BYTES = 64 * 1024 * 1024
const PORCELAIN_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/u
const ZERO_SHA = /^0+$/u

export interface ReadBlameOptions {
  signal?: AbortSignal | undefined
  /** Size limit override (tests). */
  maxBytes?: number | undefined
}

export interface ParsedBlame {
  lines: string[]
  segments: BlameSegment[]
  commits: Record<string, BlameCommit>
}

/**
 * Parse `git blame --line-porcelain` output into page lines, merged segments and commit facts.
 * @param path - repository path the blame was asked for; segments name a different `filename` as `origPath`.
 */
export function parseLinePorcelain(output: string, path: string): ParsedBlame {
  const lines: string[] = []
  const segments: BlameSegment[] = []
  const commits: Record<string, BlameCommit> = {}
  let current: { sha: string; final: number; fields: Map<string, string>; boundary: boolean } | null = null
  for (const raw of output.split('\n')) {
    if (current === null) {
      const header = PORCELAIN_HEADER.exec(raw)
      if (header !== null) current = { sha: header[1] ?? '', final: Number(header[3]), fields: new Map(), boundary: false }
      continue
    }
    if (raw.startsWith('\t')) {
      const text = raw.slice(1).replace(/\r$/u, '')
      lines.push(text)
      const filename = current.fields.get('filename') ?? path
      commits[current.sha] ??= commitOf(current.sha, current.fields, current.boundary)
      const last = segments.at(-1)
      const origPath = filename === path ? undefined : filename
      if (last !== undefined && last.sha === current.sha && last.origPath === origPath && last.start + last.count === current.final) {
        last.count += 1
      } else {
        segments.push(origPath === undefined
          ? { sha: current.sha, start: current.final, count: 1 }
          : { sha: current.sha, start: current.final, count: 1, origPath })
      }
      current = null
      continue
    }
    if (raw === 'boundary') {
      current.boundary = true
      continue
    }
    const space = raw.indexOf(' ')
    if (space > 0) current.fields.set(raw.slice(0, space), raw.slice(space + 1))
  }
  return { lines, segments, commits }
}

function commitOf(sha: string, fields: Map<string, string>, boundary: boolean): BlameCommit {
  const mail = fields.get('author-mail') ?? ''
  const commit: BlameCommit = {
    sha,
    shortSha: sha.slice(0, 7),
    author: fields.get('author') ?? '',
    email: mail.replace(/^<|>$/gu, ''),
    date: isoDate(fields.get('author-time'), fields.get('author-tz')),
    subject: fields.get('summary') ?? '',
    uncommitted: ZERO_SHA.test(sha),
    boundary,
  }
  const previous = fields.get('previous')
  if (previous !== undefined) {
    const space = previous.indexOf(' ')
    if (space > 0) commit.previous = { sha: previous.slice(0, space), path: previous.slice(space + 1) }
  }
  return commit
}

/** `author-time` (epoch seconds) + `author-tz` (`+0800`) → ISO 8601 with that offset, like `%aI`. */
function isoDate(time: string | undefined, tz: string | undefined): string {
  const seconds = Number(time ?? '0')
  const match = /^([+-])(\d{2})(\d{2})$/u.exec(tz ?? '')
  const sign = match?.[1] === '-' ? -1 : 1
  const offsetMinutes = match === null ? 0 : sign * (Number(match[2]) * 60 + Number(match[3]))
  const local = new Date((seconds + offsetMinutes * 60) * 1000).toISOString().slice(0, 19)
  const zone = match === null ? '+00:00' : `${match[1] ?? '+'}${match[2] ?? '00'}:${match[3] ?? '00'}`
  return `${local}${zone}`
}

function countLines(text: string): number {
  if (text === '') return 0
  let count = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1
  return text.endsWith('\n') ? count - 1 : count
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidPayload(`${label} must be a positive integer`, {})
  }
  return value
}

function emptyValue(path: string, rev: string | null, extra: Partial<BlameValue>): BlameValue {
  return { path, rev, totalLines: 0, start: 1, lines: [], segments: [], commits: {}, binary: false, tooLarge: false, ...extra }
}

/** Read one page of blame for `request.path` at `request.rev` (or the worktree). */
export async function readBlame(
  run: GitRunner,
  cwd: string,
  request: BlameRequest,
  options: ReadBlameOptions = {},
): Promise<BlameValue> {
  const { signal } = options
  const maxBytes = options.maxBytes ?? BLAME_MAX_BYTES
  const path = validateRepoPath(request.path)
  const start = positiveInteger(request.start, 'start', 1)
  const limit = Math.min(positiveInteger(request.limit, 'limit', BLAME_PAGE_MAX_LINES), BLAME_PAGE_MAX_LINES)
  const rev = request.rev === undefined ? null : await resolveRevision(run, cwd, request.rev, 'rev', signal)

  const content = rev === null
    ? await worktreeContent(run, cwd, path, maxBytes, signal)
    : await revisionContent(run, cwd, rev, path, maxBytes, signal)
  if (content.kind === 'unavailable') return emptyValue(path, rev, { unavailable: content.reason })
  if (content.kind === 'too-large') {
    const command = rev === null ? `git blame -- ${shellQuote(path)}` : `git blame ${rev} -- ${shellQuote(path)}`
    return emptyValue(path, rev, { tooLarge: true, terminalCommand: command })
  }
  if (content.text.includes('\0')) return emptyValue(path, rev, { binary: true })

  const totalLines = countLines(content.text)
  if (totalLines === 0) {
    if (start !== 1) throw invalidPayload('start is past the end of the file', { start, totalLines })
    return emptyValue(path, rev, {})
  }
  if (start > totalLines) throw invalidPayload('start is past the end of the file', { start, totalLines })
  const count = Math.min(limit, totalLines - start + 1)
  const result = await run(
    [
      ...GIT_BASE_ARGV, 'blame', '--line-porcelain', '--root', '--no-textconv', '-L', `${String(start)},+${String(count)}`,
      ...(rev === null ? [] : [rev]), '--', path,
    ],
    { cwd, signal, stdoutMaxBytes: BLAME_STDOUT_MAX_BYTES },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git blame')
  const parsed = parseLinePorcelain(result.stdout, path)
  await markShallowBoundary(run, cwd, parsed.commits, signal)
  const end = start + parsed.lines.length
  return {
    path,
    rev,
    totalLines,
    start,
    ...parsed,
    ...(end <= totalLines ? { next: end } : {}),
    binary: false,
    tooLarge: false,
  }
}

/**
 * `--root` reports a shallow clone's grafted edge like a root commit; mark the commits listed in the
 * repository's `shallow` file as the boundary instead. Only asked when some commit has no `previous`.
 */
async function markShallowBoundary(
  run: GitRunner,
  cwd: string,
  commits: Record<string, BlameCommit>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const candidates = Object.values(commits).filter(commit => !commit.uncommitted && commit.previous === undefined)
  if (candidates.length === 0) return
  const shallow = await run([...GIT_BASE_ARGV, 'rev-parse', '--is-shallow-repository', '--git-path', 'shallow'], { cwd, signal })
  if (shallow.exitCode !== 0) throw failureFromExit(shallow, 'git rev-parse')
  const [isShallow, shallowPath] = shallow.stdout.split('\n')
  if (isShallow?.trim() !== 'true' || shallowPath === undefined) return
  let listed: Set<string>
  try {
    listed = new Set((await readFile(resolve(cwd, shallowPath.trim()), 'utf8')).split('\n').map(line => line.trim()))
  } catch {
    return
  }
  for (const commit of candidates) if (listed.has(commit.sha)) commit.boundary = true
}

type Content =
  | { kind: 'text'; text: string }
  | { kind: 'too-large' }
  | { kind: 'unavailable'; reason: 'untracked' | 'missing' }

async function revisionContent(
  run: GitRunner,
  cwd: string,
  rev: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Content> {
  const object = `${rev}:${path}`
  const size = await run([...GIT_BASE_ARGV, 'cat-file', '-s', object], { cwd, signal })
  if (size.exitCode !== 0) return { kind: 'unavailable', reason: 'missing' }
  if (Number(size.stdout.trim()) > maxBytes) return { kind: 'too-large' }
  const blob = await run([...GIT_BASE_ARGV, 'cat-file', 'blob', object], { cwd, signal, stdoutMaxBytes: maxBytes + 1 })
  if (blob.exitCode !== 0) throw failureFromExit(blob, 'git cat-file')
  return { kind: 'text', text: blob.stdout }
}

async function worktreeContent(
  run: GitRunner,
  cwd: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Content> {
  const file = await readWorktreeFile(cwd, path, maxBytes)
  if (file.kind === 'missing' || file.kind === 'not-file') return { kind: 'unavailable', reason: 'missing' }
  // Blame of the worktree attributes against HEAD: a path HEAD does not have has nothing to blame yet.
  const tracked = await run([...GIT_BASE_ARGV, 'cat-file', '-e', `HEAD:${path}`], { cwd, signal })
  if (tracked.exitCode !== 0) return { kind: 'unavailable', reason: 'untracked' }
  if (file.kind === 'too-large') return { kind: 'too-large' }
  return { kind: 'text', text: file.bytes.toString('utf8') }
}
