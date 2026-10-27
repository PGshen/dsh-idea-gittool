// status 命令与 `--porcelain=v2 -z` 解析（可行性调研 §6.3、§8.3）。
// 机器可读：不用 `--short`，不依赖人类可读的本地化文案。

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ConflictKind,
  FileEntry,
  FileStatusCode,
  OperationStep,
  RebaseStop,
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
  // Every untracked file individually (评审 C1): a bare `newdir/` entry cannot be committed or rolled back by path.
  return [...GIT_BASE_ARGV, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']
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

/** Unmerged XY → conflict kind (git-status(1) "Unmerged entries"; A3 T1). */
const CONFLICT_KINDS: Readonly<Record<string, ConflictKind>> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
}

/** Conflict kind of an unmerged record; an unknown XY falls back to both-modified. */
export function conflictKindOf(xy: string): ConflictKind {
  return CONFLICT_KINDS[xy] ?? 'both-modified'
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
  const gitDir = await resolveGitDir(run, cwd, options.signal)
  const operation = gitDir === undefined ? null : await detectOperationIn(gitDir)
  const result = await run(buildStatusArgv(), { cwd, signal: options.signal })
  if (result.exitCode !== 0) throw failureFromExit(result, 'git status')
  const status = parseStatusPorcelainV2Z(result.stdout, {
    entryLimit: options.entryLimit,
    operation,
  })
  if (operation === 'rebase' && gitDir !== undefined) {
    // Same reader as `operationState` (A3 T2): two small files, no git call.
    const step = await readRebaseStep(gitDir)
    if (step !== undefined) status.operationStep = step
    const stop = await readRebaseStop(gitDir, status.conflicts.length)
    if (stop !== undefined) status.rebaseStop = stop
  }
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
      emit(conflicts, { path: fields.slice(10).join(' '), status: 'U', conflict: conflictKindOf(fields[1] ?? 'UU') })
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

/** Absolute git directory of `cwd` (per worktree); undefined when git cannot tell. */
export async function resolveGitDir(
  run: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let resolved: GitRunResult
  try {
    resolved = await run([...GIT_BASE_ARGV, 'rev-parse', '--absolute-git-dir'], { cwd, signal })
  } catch {
    // The status read that follows reports the authoritative failure.
    return undefined
  }
  if (resolved.exitCode !== 0) return undefined
  const gitDir = resolved.stdout.trim()
  return gitDir === '' ? undefined : gitDir
}

/** Detect an in-progress merge/rebase/cherry-pick/revert from git's marker files. */
export async function detectOperation(
  run: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RepoOperation> {
  const gitDir = await resolveGitDir(run, cwd, signal)
  return gitDir === undefined ? null : await detectOperationIn(gitDir)
}

/** {@link detectOperation} for an already resolved git directory. */
export async function detectOperationIn(gitDir: string): Promise<RepoOperation> {
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

/** Trimmed content of a small git state file; undefined when absent or unreadable. */
export async function readStateFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/** The rebase state directory in use (`rebase-merge` for the merge backend, `rebase-apply` for apply). */
export async function rebaseStateDir(gitDir: string): Promise<string | undefined> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const dir = join(gitDir, name)
    if (await pathExists(dir)) return dir
  }
  return undefined
}

/**
 * Why an interactive rebase stopped (plan b3a, references/git-behavior §4): unmerged index entries →
 * `conflict`; last `done` command `edit` with an `amend` marker → `edit`; last `done` command `exec` →
 * `exec-failed`. Undefined outside `rebase-merge` or for any other stop.
 */
export async function readRebaseStop(gitDir: string, conflicts: number): Promise<RebaseStop | undefined> {
  const dir = join(gitDir, 'rebase-merge')
  if (!(await pathExists(dir))) return undefined
  if (conflicts > 0) return 'conflict'
  const done = (await readStateFile(join(dir, 'done'))) ?? ''
  const last = done.split('\n').filter(line => line !== '' && !line.startsWith('#')).at(-1) ?? ''
  const command = last.split(' ', 1)[0] ?? ''
  if ((command === 'edit' || command === 'e') && (await pathExists(join(dir, 'amend')))) return 'edit'
  if (command === 'exec' || command === 'x') return 'exec-failed'
  return undefined
}

/**
 * Rebase progress: `rebase-merge/{msgnum,end}` or `rebase-apply/{next,last}`.
 * Undefined outside a rebase or when the counters are missing or malformed.
 */
export async function readRebaseStep(gitDir: string): Promise<OperationStep | undefined> {
  const dir = await rebaseStateDir(gitDir)
  if (dir === undefined) return undefined
  const merge = dir.endsWith('rebase-merge')
  const current = Number(await readStateFile(join(dir, merge ? 'msgnum' : 'next')))
  const total = Number(await readStateFile(join(dir, merge ? 'end' : 'last')))
  if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || total < 1) return undefined
  return { current: Math.min(current, total), total }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
