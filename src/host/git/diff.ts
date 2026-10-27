// 单文件 diff（A1，产品设计 §9.3、§16.8）：
// - path 只接受 repo 相对 POSIX 路径；绝对路径、`..`、`.`、空段、`.git` 段一律 git/invalid-payload；
//   命令里 path 永远位于 `--` 之后，执行层环境固定 GIT_LITERAL_PATHSPECS=1（不是 glob/magic）。
// - 先用 `--raw -z` 定位这个文件的变化（状态、重命名源、blob sha）；staged/commit 在整棵树上做 -M，
//   这样只请求新路径也能识别重命名；再用 `-- <old> <new>` 取 patch 并解析为 hunk/行。
// - 仓库配置不得改变输出形状：显式关闭颜色/外部 diff/textconv/相对路径，固定 a/ b/ 前缀与 -U3。
// - 二进制：`Binary files … differ` → binary=true，大小来自 `cat-file -s`（工作区一侧用 lstat）。
// - 单文件超过 DIFF_FILE_MAX_BYTES / DIFF_FILE_MAX_LINES：truncated + 原因，保留已解析前缀；
//   patch 超过 DIFF_RESPONSE_MAX_BYTES 时执行层拒绝半截流，此时返回 truncated 且无 hunk。
// - 未跟踪文件（worktree）：`diff --no-index -- /dev/null <path>`，退出码 1 是正常结果。

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  DiffFileValue,
  DiffHunk,
  DiffLine,
  DiffScope,
  FileStatusCode,
} from '../../shared/protocol.ts'
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_FILE_MAX_LINES,
  DIFF_RESPONSE_MAX_BYTES,
} from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import type { RawChange } from './commit.ts'
import { parseRawNumstat, resolveCommitSha } from './commit.ts'
import { resolveRevision } from './revision.ts'

const MAX_PATH_LENGTH = 4096
const NULL_SHA = /^0+$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Options that pin the output shape regardless of repository/user diff config. */
const DIFF_SHAPE_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
  '-M',
] as const

export interface DiffQuery {
  path: unknown
  scope: unknown
  sha?: unknown
  parent?: unknown
  /** scope=range (B2): old side, new side (null = worktree), diff from their merge base. */
  from?: unknown
  to?: unknown
  mergeBase?: unknown
  /** scope=range: the file's path on the old side when it was renamed (limits the scan to both paths). */
  origPath?: unknown
}

export interface ReadDiffOptions {
  signal?: AbortSignal | undefined
  /** Limit overrides (tests). */
  maxBytes?: number | undefined
  maxLines?: number | undefined
  responseMaxBytes?: number | undefined
}

export interface ParseDiffLimits {
  maxBytes: number
  maxLines: number
}

export interface ParsedPatch {
  binary: boolean
  oldSha?: string
  newSha?: string
  hunks: DiffHunk[]
  truncated: boolean
  truncatedReason?: 'bytes' | 'lines'
}

/** Validate a client path: repo-relative POSIX, no traversal, never inside `.git`. */
export function validateRepoPath(path: unknown): string {
  if (typeof path !== 'string' || path === '') throw invalidPayload('path must be a non-empty string')
  if (path.length > MAX_PATH_LENGTH) throw invalidPayload('path is too long')
  if (path.includes('\0')) throw invalidPayload('path must not contain NUL')
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw invalidPayload('path must be repository-relative')
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalidPayload('path must not contain empty, "." or ".." segments')
    }
    if (segment.toLowerCase() === '.git') throw invalidPayload('path must not address .git')
  }
  return path
}

/** Parse one file's unified patch; stops (keeping the prefix) once a limit is crossed. */
export function parseUnifiedDiff(text: string, limits: ParseDiffLimits): ParsedPatch {
  const result: ParsedPatch = { binary: false, hunks: [], truncated: false }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let bytes = 0
  let count = 0
  let index = 0

  // Header: everything before the first hunk.
  while (index < lines.length && !(lines[index] ?? '').startsWith('@@')) {
    const line = lines[index] ?? ''
    const shas = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line)
    if (shas !== null) {
      result.oldSha = shas[1]
      result.newSha = shas[2]
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') result.binary = true
    index += 1
  }
  if (result.binary) return result

  while (index < lines.length) {
    const header = lines[index] ?? ''
    const match = HUNK_HEADER.exec(header)
    if (match === null) break
    index += 1
    const hunk: DiffHunk = {
      header,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    }
    result.hunks.push(hunk)
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    let oldLeft = hunk.oldLines
    let newLeft = hunk.newLines

    while (index < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[index] ?? '').startsWith('\\'))) {
      const raw = lines[index] ?? ''
      index += 1
      // "\ No newline at end of file" annotates the previous line; not content.
      if (raw.startsWith('\\')) continue
      const marker = raw.charAt(0)
      const text = raw.slice(1)
      let line: DiffLine
      if (marker === '+') {
        line = { type: 'add', newLine, text }
        newLine += 1
        newLeft -= 1
      } else if (marker === '-') {
        line = { type: 'del', oldLine, text }
        oldLine += 1
        oldLeft -= 1
      } else {
        // ' ' context, or '' when diff.suppressBlankEmpty strips the marker of a blank line.
        line = { type: 'context', oldLine, newLine, text }
        oldLine += 1
        newLine += 1
        oldLeft -= 1
        newLeft -= 1
      }
      const size = Buffer.byteLength(text, 'utf8') + 1
      if (count + 1 > limits.maxLines) return truncate(result, 'lines')
      if (bytes + size > limits.maxBytes) return truncate(result, 'bytes')
      count += 1
      bytes += size
      hunk.lines.push(line)
    }
  }
  return result
}

/** Read one file's diff for the given scope. */
export async function readDiff(
  run: GitRunner,
  cwd: string,
  query: DiffQuery,
  options: ReadDiffOptions = {},
): Promise<DiffFileValue> {
  const { signal } = options
  const path = validateRepoPath(query.path)
  const scope = parseScope(query.scope)
  if (scope !== 'commit' && (query.sha !== undefined || query.parent !== undefined)) {
    throw invalidPayload('sha/parent are only valid for scope "commit"')
  }
  if (scope !== 'range' && (query.from !== undefined || query.to !== undefined || query.mergeBase !== undefined || query.origPath !== undefined)) {
    throw invalidPayload('from/to/mergeBase/origPath are only valid for scope "range"')
  }
  const origPath = query.origPath === undefined ? undefined : validateRepoPath(query.origPath)

  const range = await rangeArgs(run, cwd, scope, query, signal)

  // 1. Locate the change: status, rename source, blob shas.
  const rawArgv = [
    ...GIT_BASE_ARGV,
    'diff',
    ...DIFF_SHAPE_ARGS,
    '--raw',
    '-z',
    '--no-abbrev',
    ...range,
    '--',
    // Worktree renames do not exist (unstaged files are add/delete); staged/commit scan the whole
    // tree so a rename into `path` is recognized. A range (B2) can span thousands of files: it scans
    // only this file and, when the caller knows it, its old path (终审 I3).
    ...(scope === 'worktree' ? [path] : scope === 'range' ? (origPath === undefined || origPath === path ? [path] : [origPath, path]) : []),
  ]
  const rawResult = await run(rawArgv, { cwd, signal })
  if (rawResult.exitCode !== 0) throw failureFromExit(rawResult, 'git diff --raw')
  const change = parseRawNumstat(rawResult.stdout).find(
    (candidate) => candidate.path === path || candidate.origPath === path,
  )

  if (change === undefined) {
    if (scope === 'worktree' && (await isUntracked(run, cwd, path, signal))) {
      return await untrackedDiff(run, cwd, path, options)
    }
    return { oldPath: path, newPath: path, status: 'M', binary: false, hunks: [], truncated: false }
  }

  // 2. The patch for exactly this change.
  const paths = change.origPath === undefined ? [change.path] : [change.origPath, change.path]
  const patch = await runPatch(
    run,
    cwd,
    [...GIT_BASE_ARGV, '-c', 'core.quotepath=false', 'diff', ...DIFF_SHAPE_ARGS, '--full-index', '-U3', ...range, '--', ...paths],
    [0],
    options,
  )
  const value = toValue(change, patch)
  if (patch.binary) await fillBinarySizes(run, cwd, value, change, scope, signal)
  return value
}

function toValue(change: RawChange, patch: ParsedPatch): DiffFileValue {
  const status: FileStatusCode = change.status
  const value: DiffFileValue = {
    oldPath: status === 'A' ? null : (change.origPath ?? change.path),
    newPath: status === 'D' ? null : change.path,
    status,
    binary: patch.binary,
    hunks: patch.hunks,
    truncated: patch.truncated,
  }
  if (patch.truncatedReason !== undefined) value.truncatedReason = patch.truncatedReason
  if (patch.binary) {
    const oldSha = patch.oldSha ?? change.oldSha
    const newSha = patch.newSha ?? change.newSha
    if (!NULL_SHA.test(oldSha)) value.oldSha = oldSha
    if (newSha !== '' && !NULL_SHA.test(newSha)) value.newSha = newSha
  }
  return value
}

async function fillBinarySizes(
  run: GitRunner,
  cwd: string,
  value: DiffFileValue,
  change: RawChange,
  scope: DiffScope,
  signal: AbortSignal | undefined,
): Promise<void> {
  const [oldSize, newSize] = await Promise.all([
    value.oldSha === undefined ? undefined : blobSize(run, cwd, value.oldSha, signal),
    value.newPath === null
      ? undefined
      : scope === 'worktree' || value.newSha === undefined
        ? worktreeSize(cwd, change.path)
        : blobSize(run, cwd, value.newSha, signal),
  ])
  if (oldSize !== undefined) value.oldSize = oldSize
  if (newSize !== undefined) value.newSize = newSize
}

async function blobSize(
  run: GitRunner,
  cwd: string,
  sha: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const result = await run([...GIT_BASE_ARGV, 'cat-file', '-s', sha], { cwd, signal })
  if (result.exitCode !== 0) return undefined
  const size = Number(result.stdout.trim())
  return Number.isSafeInteger(size) ? size : undefined
}

async function worktreeSize(cwd: string, path: string): Promise<number | undefined> {
  try {
    // lstat: a symlink's own size, never its (possibly out-of-repo) target.
    return (await lstat(join(cwd, path))).size
  } catch {
    return undefined
  }
}

async function isUntracked(
  run: GitRunner,
  cwd: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await run(
    [...GIT_BASE_ARGV, 'ls-files', '-z', '--others', '--exclude-standard', '--', path],
    { cwd, signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git ls-files')
  return result.stdout.split('\0').includes(path)
}

async function untrackedDiff(
  run: GitRunner,
  cwd: string,
  path: string,
  options: ReadDiffOptions,
): Promise<DiffFileValue> {
  const patch = await runPatch(
    run,
    cwd,
    [...GIT_BASE_ARGV, 'diff', '--no-index', ...DIFF_SHAPE_ARGS, '--full-index', '-U3', '--', '/dev/null', path],
    // --no-index exits 1 when the files differ, which is always the case here.
    [0, 1],
    options,
  )
  const value: DiffFileValue = {
    oldPath: null,
    newPath: path,
    status: '?',
    binary: patch.binary,
    hunks: patch.hunks,
    truncated: patch.truncated,
  }
  if (patch.truncatedReason !== undefined) value.truncatedReason = patch.truncatedReason
  if (patch.binary) {
    const size = await worktreeSize(cwd, path)
    if (size !== undefined) value.newSize = size
    if (patch.newSha !== undefined && !NULL_SHA.test(patch.newSha)) value.newSha = patch.newSha
  }
  return value
}

async function runPatch(
  run: GitRunner,
  cwd: string,
  argv: string[],
  okExitCodes: number[],
  options: ReadDiffOptions,
): Promise<ParsedPatch> {
  const limits: ParseDiffLimits = {
    maxBytes: options.maxBytes ?? DIFF_FILE_MAX_BYTES,
    maxLines: options.maxLines ?? DIFF_FILE_MAX_LINES,
  }
  let stdout: string
  try {
    const result = await run(argv, {
      cwd,
      signal: options.signal,
      stdoutMaxBytes: options.responseMaxBytes ?? DIFF_RESPONSE_MAX_BYTES,
    })
    if (result.exitCode === null || !okExitCodes.includes(result.exitCode)) {
      throw failureFromExit(result, 'git diff')
    }
    stdout = result.stdout
  } catch (error) {
    // The executor refuses a lossy stream; the prefix is gone, so report an empty truncated diff.
    if (error instanceof GitCommandFailure && error.code === 'git/output-too-large') {
      return { binary: false, hunks: [], truncated: true, truncatedReason: 'bytes' }
    }
    throw error
  }
  return parseUnifiedDiff(stdout, limits)
}

async function rangeArgs(
  run: GitRunner,
  cwd: string,
  scope: DiffScope,
  query: DiffQuery,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (scope === 'worktree') return []
  if (scope === 'staged') return ['--cached']
  if (scope === 'range') return await revisionRangeArgs(run, cwd, query, signal)

  if (query.sha === undefined) throw invalidPayload('sha is required for scope "commit"')
  const sha = await resolveCommitSha(run, cwd, query.sha, signal)
  const listed = await run([...GIT_BASE_ARGV, 'rev-list', '--parents', '-n', '1', sha, '--'], {
    cwd,
    signal,
  })
  if (listed.exitCode !== 0) throw failureFromExit(listed, 'git rev-list')
  const parents = listed.stdout.trim().split(' ').slice(1)

  let base: string
  if (query.parent !== undefined) {
    const parent = await resolveCommitSha(run, cwd, query.parent, signal, 'parent')
    if (!parents.includes(parent)) {
      throw invalidPayload('parent is not a parent of sha', { sha, parent })
    }
    base = parent
  } else if (parents[0] !== undefined) {
    base = parents[0]
  } else {
    // Root commit: compare against the empty tree of this repository's hash algorithm.
    const empty = await run([...GIT_BASE_ARGV, 'hash-object', '-t', 'tree', '/dev/null'], {
      cwd,
      signal,
    })
    if (empty.exitCode !== 0) throw failureFromExit(empty, 'git hash-object')
    base = empty.stdout.trim()
  }
  return [base, sha]
}

/**
 * scope=range (B2): `[from, to]`, `[from]` (to = worktree), or `[mergeBase(from, to), to]`. Unrelated
 * histories have no merge base; the diff then falls back to the two revisions themselves.
 */
async function revisionRangeArgs(
  run: GitRunner,
  cwd: string,
  query: DiffQuery,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (query.mergeBase !== undefined && typeof query.mergeBase !== 'boolean') throw invalidPayload('mergeBase must be a boolean')
  const from = await resolveRevision(run, cwd, query.from, 'from', signal)
  if (query.to === null || query.to === undefined) {
    if (query.mergeBase === true) throw invalidPayload('mergeBase needs a revision on both sides')
    return [from]
  }
  const to = await resolveRevision(run, cwd, query.to, 'to', signal)
  if (query.mergeBase !== true) return [from, to]
  return [(await mergeBaseOf(run, cwd, from, to, signal)) ?? from, to]
}

/** The best common ancestor of two commits, or null for unrelated histories. */
export async function mergeBaseOf(
  run: GitRunner,
  cwd: string,
  left: string,
  right: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await run([...GIT_BASE_ARGV, 'merge-base', left, right], { cwd, signal })
  if (result.exitCode === 0) return result.stdout.trim()
  if (result.exitCode === 1) return null
  throw failureFromExit(result, 'git merge-base')
}

function parseScope(scope: unknown): DiffScope {
  if (scope === 'worktree' || scope === 'staged' || scope === 'commit' || scope === 'range') return scope
  throw invalidPayload('scope must be "worktree", "staged", "commit" or "range"')
}

function truncate(result: ParsedPatch, reason: 'bytes' | 'lines'): ParsedPatch {
  result.truncated = true
  result.truncatedReason = reason
  return result
}

function invalidPayload(message: string, details: Record<string, unknown> = {}): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}
