// status 命令与 `--porcelain=v2 -z` 解析（可行性调研 §6.3、§8.3）。
// 机器可读：不用 `--short`，不依赖人类可读的本地化文案。

import { access } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  FileEntry,
  FileStatusCode,
  RepoOperation,
  StatusValue,
} from '../../shared/protocol.ts'
import { STATUS_ENTRY_LIMIT } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'

/** Options accepted by both the parser and the command wrapper. */
export interface ReadStatusOptions {
  signal?: AbortSignal | undefined
  entryLimit?: number | undefined
}

/** Parse options: operation and truncation are facts the caller already knows. */
export interface ParseStatusOptions extends ReadStatusOptions {
  operation?: RepoOperation | undefined
  truncated?: boolean | undefined
}

/** argv for one `git status` read (no user-controlled values, no pathspec). */
export function buildStatusArgv(): string[] {
  return [...GIT_BASE_ARGV, 'status', '--porcelain=v2', '--branch', '-z']
}

const TRACKED_STATUS: Readonly<Record<string, FileStatusCode>> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  C: 'C',
  T: 'T',
  U: 'U',
}

function toFileStatus(letter: string | undefined): FileStatusCode {
  if (letter === undefined) return 'M'
  return TRACKED_STATUS[letter] ?? 'M'
}

/** Read the working-tree status of `cwd`, resolving nothing (caller passes the repo root). */
export async function readStatus(
  run: GitRunner,
  cwd: string,
  options: ReadStatusOptions = {},
): Promise<StatusValue> {
  const operation = await detectOperation(run, cwd, options.signal)
  const result = await run(buildStatusArgv(), { cwd, signal: options.signal })
  if (result.exitCode !== 0) throw failureFromExit(result, 'git status')
  const status = parseStatusPorcelainV2Z(result.stdout, {
    entryLimit: options.entryLimit,
    operation,
  })
  const stashCount = await readStashCount(run, cwd, options.signal)
  if (stashCount !== undefined) status.stashCount = stashCount
  return status
}

/**
 * Number of stash entries via `git stash list`, which exits 0 with empty output when there
 * is no stash. (`rev-list --walk-reflogs refs/stash` exits 128 without a stash: polled every
 * 3s, that expected miss flooded the Git console with red failures — A1 acceptance demo.)
 * Any failure omits the count rather than failing the whole status read.
 */
async function readStashCount(
  run: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  let result: GitRunResult
  try {
    result = await run([...GIT_BASE_ARGV, 'stash', 'list', '--format=%H'], { cwd, signal })
  } catch {
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * Record kinds: `1` changed, `2` renamed/copied (the original path is the next
 * NUL-separated token), `u` unmerged, `?` untracked, `!` ignored, `#` headers.
 * A record outside this grammar fails the whole read: partial data is worse
 * than a structured error (可行性调研 §8.3).
 */
export function parseStatusPorcelainV2Z(
  raw: string,
  options: ParseStatusOptions = {},
): StatusValue {
  const entryLimit = options.entryLimit ?? STATUS_ENTRY_LIMIT
  const staged: FileEntry[] = []
  const unstaged: FileEntry[] = []
  const untracked: FileEntry[] = []
  const conflicts: FileEntry[] = []
  let branch: string | null = null
  let detached = false
  let head: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let emitted = 0
  let truncated = options.truncated === true

  const emit = (target: FileEntry[], entry: FileEntry): void => {
    if (emitted >= entryLimit) {
      truncated = true
      return
    }
    target.push(entry)
    emitted += 1
  }

  const chunks = raw.split('\0')
  let index = 0
  while (index < chunks.length) {
    const chunk = chunks[index]
    index += 1
    if (chunk === undefined || chunk === '') continue

    if (chunk.startsWith('# ')) {
      parseHeader(chunk.slice(2), {
        setBranch: (value) => {
          branch = value
        },
        setDetached: (value) => {
          detached = value
        },
        setHead: (value) => {
          head = value
        },
        setUpstream: (value) => {
          upstream = value
        },
        setAheadBehind: (nextAhead, nextBehind) => {
          ahead = nextAhead
          behind = nextBehind
        },
      })
      continue
    }

    const kind = chunk[0]
    const separator = chunk[1]
    if (separator !== ' ') throw unparseable(chunk)

    if (kind === '1') {
      const fields = chunk.split(' ')
      if (fields.length < 9) throw unparseable(chunk)
      const xy = fields[1] ?? '.'
      const path = fields.slice(8).join(' ')
      pushChanged(emit, staged, unstaged, xy, path)
      continue
    }
    if (kind === '2') {
      const fields = chunk.split(' ')
      if (fields.length < 10) throw unparseable(chunk)
      const origPath = chunks[index]
      if (origPath === undefined || origPath === '') throw unparseable(chunk)
      index += 1
      const xy = fields[1] ?? '.'
      const path = fields.slice(9).join(' ')
      const x = xy[0]
      const y = xy[1]
      if (x !== undefined && x !== '.') {
        emit(staged, { path, origPath, status: toFileStatus(x) })
      }
      if (y !== undefined && y !== '.') {
        emit(unstaged, { path, origPath, status: toFileStatus(y) })
      }
      continue
    }
    if (kind === 'u') {
      const fields = chunk.split(' ')
      if (fields.length < 11) throw unparseable(chunk)
      emit(conflicts, { path: fields.slice(10).join(' '), status: 'U' })
      continue
    }
    if (kind === '?') {
      emit(untracked, { path: chunk.slice(2), status: '?' })
      continue
    }
    if (kind === '!') {
      // Ignored files are deliberately not part of the workbench surface.
      continue
    }
    throw unparseable(chunk)
  }

  return {
    branch,
    detached,
    head,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    operation: options.operation ?? null,
    truncated,
  }
}

function pushChanged(
  emit: (target: FileEntry[], entry: FileEntry) => void,
  staged: FileEntry[],
  unstaged: FileEntry[],
  xy: string,
  path: string,
): void {
  const x = xy[0]
  const y = xy[1]
  if (x !== undefined && x !== '.') emit(staged, { path, status: toFileStatus(x) })
  if (y !== undefined && y !== '.') emit(unstaged, { path, status: toFileStatus(y) })
}

interface HeaderSink {
  setBranch: (value: string | null) => void
  setDetached: (value: boolean) => void
  setHead: (value: string | null) => void
  setUpstream: (value: string | null) => void
  setAheadBehind: (ahead: number, behind: number) => void
}

function parseHeader(header: string, sink: HeaderSink): void {
  const space = header.indexOf(' ')
  if (space < 0) return
  const key = header.slice(0, space)
  const value = header.slice(space + 1)

  if (key === 'branch.oid') {
    sink.setHead(value === '(initial)' ? null : value)
    return
  }
  if (key === 'branch.head') {
    if (value === '(detached)') {
      sink.setBranch(null)
      sink.setDetached(true)
    } else {
      sink.setBranch(value)
      sink.setDetached(false)
    }
    return
  }
  if (key === 'branch.upstream') {
    sink.setUpstream(value)
    return
  }
  if (key === 'branch.ab') {
    const match = /^\+(\d+) -(\d+)$/.exec(value)
    if (match !== null) {
      sink.setAheadBehind(Number(match[1]), Number(match[2]))
    }
  }
}

function unparseable(chunk: string): GitCommandFailure {
  return new GitCommandFailure('git/exec-failed', 'unparseable git status record', {
    record: chunk.slice(0, 200),
  })
}

/** Detect an in-progress merge/rebase/cherry-pick/revert from git's marker files. */
export async function detectOperation(
  run: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RepoOperation> {
  let resolved: GitRunResult
  try {
    resolved = await run([...GIT_BASE_ARGV, 'rev-parse', '--absolute-git-dir'], { cwd, signal })
  } catch {
    // The status read that follows reports the authoritative failure.
    return null
  }
  if (resolved.exitCode !== 0) return null
  const gitDir = resolved.stdout.trim()
  if (gitDir === '') return null

  if ((await pathExists(join(gitDir, 'rebase-merge'))) || (await pathExists(join(gitDir, 'rebase-apply')))) {
    return 'rebase'
  }
  if (await pathExists(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (await pathExists(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (await pathExists(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  // `git bisect` keeps BISECT_START for the whole session (removed by `bisect reset`).
  if (await pathExists(join(gitDir, 'BISECT_START'))) return 'bisect'
  return null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
