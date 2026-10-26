// A2 写端点共用的小工具：载荷校验、操作状态判定、hook 存在性、输出脱敏摘要、认证失败识别。
// 只被 src/host/git/{commit-write,rollback,push,pull}.ts 使用。

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { RepoOperation } from '../../shared/protocol.ts'
import { COMMIT_MESSAGE_MAX_BYTES, WRITE_PATHS_MAX } from '../../shared/protocol.ts'
import { redactCredentials, truncateConsoleOutput } from '../console.ts'
import type { GitRunResult, GitRunner, WriteContext } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { validateRepoPath } from './diff.ts'
import { detectOperation } from './status.ts'

/** A full object id (SHA-1 or SHA-256 hex). */
export const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Hook output kept in `git/hook-failed` details (UTF-8 bytes). */
export const HOOK_OUTPUT_MAX_BYTES = 4096

const REF_COMPONENT_MAX = 256

export function invalidPayload(message: string, details: Record<string, unknown> = {}): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}

/** The payload as a plain record, or `git/invalid-payload`. */
export function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalidPayload('payload must be an object')
  }
  return payload as Record<string, unknown>
}

/** Non-empty (unless `allowEmpty`), duplicate-free, bounded list of validated repo-relative paths. */
export function parseWritePaths(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw invalidPayload('paths must be an array')
  if (value.length === 0 && !allowEmpty) throw invalidPayload('paths must not be empty')
  if (value.length > WRITE_PATHS_MAX) {
    throw invalidPayload(`at most ${String(WRITE_PATHS_MAX)} paths per request`, { limit: WRITE_PATHS_MAX })
  }
  const seen = new Set<string>()
  for (const entry of value) {
    const path = validateRepoPath(entry)
    if (seen.has(path)) throw invalidPayload('paths must not contain duplicates', { path })
    seen.add(path)
  }
  return [...seen]
}

/** Commit message: trailing whitespace trimmed, non-empty, at most {@link COMMIT_MESSAGE_MAX_BYTES}. */
export function parseCommitMessage(value: unknown): string {
  if (typeof value !== 'string') throw invalidPayload('message must be a string')
  if (value.includes('\0')) throw invalidPayload('message must not contain NUL')
  const message = value.trimEnd()
  if (message.trim() === '') throw invalidPayload('message must not be empty')
  if (Buffer.byteLength(message, 'utf8') > COMMIT_MESSAGE_MAX_BYTES) {
    throw invalidPayload(`message exceeds ${String(COMMIT_MESSAGE_MAX_BYTES)} bytes`, {
      limit: COMMIT_MESSAGE_MAX_BYTES,
    })
  }
  return message
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw invalidPayload(`${key} must be a boolean`)
  return value
}

/**
 * Remote or branch name as typed by the client: non-empty, bounded, no leading `-`
 * (never an option), no whitespace/control characters. Branch names are checked
 * again by git (`check-ref-format`) before use.
 */
export function parseRefName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw invalidPayload(`${label} must be a non-empty string`)
  if (value.length > REF_COMPONENT_MAX) throw invalidPayload(`${label} is too long`)
  if (value.startsWith('-')) throw invalidPayload(`${label} must not start with "-"`)
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) throw invalidPayload(`${label} must not contain whitespace`)
  return value
}

/** A read-mode runner over the write context (queries never need confinement). */
export function readRunner(ctx: WriteContext): GitRunner {
  return (argv) => ctx.git(argv, { mode: 'read' })
}

/** Run a read-only query in the repository. */
export async function query(ctx: WriteContext, args: readonly string[]): Promise<GitRunResult> {
  return await ctx.git([...GIT_BASE_ARGV, ...args], { mode: 'read' })
}

/** Run a read-only query that must succeed; returns stdout. */
export async function queryOk(ctx: WriteContext, args: readonly string[], label: string): Promise<string> {
  const result = await query(ctx, args)
  if (result.exitCode !== 0) throw redactedFailure(result, label)
  return result.stdout
}

/** The ref exists but does not hold a readable JSON blob. */
export class JsonRefInvalid extends Error {
  constructor(readonly ref: string, reason: string) {
    super(`${ref}: ${reason}`)
    this.name = 'JsonRefInvalid'
  }
}

/**
 * Read a JSON blob stored behind a ref (ADR 0008: ref → `cat-file blob` → JSON).
 * A missing ref yields null; an unreadable blob or malformed JSON throws {@link JsonRefInvalid}
 * so callers can tell "nothing saved" from "saved but unusable".
 */
export async function readJsonRef(ctx: WriteContext, ref: string): Promise<unknown> {
  const resolved = await query(ctx, ['rev-parse', '-q', '--verify', ref])
  if (resolved.exitCode === 1) return null
  if (resolved.exitCode !== 0) throw redactedFailure(resolved, 'git rev-parse')
  const blob = await query(ctx, ['cat-file', 'blob', resolved.stdout.trim()])
  if (blob.exitCode !== 0) throw new JsonRefInvalid(ref, 'not a readable blob')
  try {
    return JSON.parse(blob.stdout) as unknown
  } catch {
    throw new JsonRefInvalid(ref, 'malformed JSON')
  }
}

/** Write `value` as a JSON blob (`hash-object -w --stdin`, confined); returns the blob id. */
export async function storeJsonBlob(ctx: WriteContext, value: unknown): Promise<string> {
  const blob = await ctx.git([...GIT_BASE_ARGV, 'hash-object', '-w', '--stdin'], { stdin: JSON.stringify(value) })
  const sha = blob.stdout.trim()
  if (blob.exitCode !== 0 || !OBJECT_ID_PATTERN.test(sha)) throw redactedFailure(blob, 'git hash-object')
  return sha
}

/**
 * Point `ref` at a new JSON blob holding `value` (ADR 0008). `alsoUpdate` ref → object pairs
 * join the same `update-ref --stdin` transaction.
 */
export async function writeJsonRef(
  ctx: WriteContext,
  ref: string,
  value: unknown,
  alsoUpdate: ReadonlyArray<readonly [string, string]> = [],
): Promise<void> {
  const sha = await storeJsonBlob(ctx, value)
  const lines = [[ref, sha] as const, ...alsoUpdate].map(([name, id]) => `update ${name} ${id}\n`)
  const updated = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '--stdin'], { stdin: lines.join('') })
  if (updated.exitCode !== 0) throw redactedFailure(updated, 'git update-ref')
}

/**
 * Delete every ref under the given prefix(es) in one transaction, except those in `keep`.
 * Returns how many refs were deleted.
 */
export async function deleteRefs(
  ctx: WriteContext,
  prefix: string | readonly string[],
  keep: ReadonlySet<string> = new Set(),
): Promise<number> {
  const prefixes = typeof prefix === 'string' ? [prefix] : prefix
  const listed = await queryOk(ctx, ['for-each-ref', '--format=%(refname)', ...prefixes], 'git for-each-ref')
  const refs = listed.split('\n').map((line) => line.trim()).filter((ref) => ref !== '' && !keep.has(ref))
  if (refs.length === 0) return 0
  const deleted = await ctx.git([...GIT_BASE_ARGV, 'update-ref', '--stdin'], {
    stdin: refs.map((ref) => `delete ${ref}\n`).join(''),
  })
  if (deleted.exitCode !== 0) throw redactedFailure(deleted, 'git update-ref')
  return refs.length
}

/** Operations that block an ordinary commit/pull (A3 owns committing inside them). */
export async function assertNoOperation(ctx: WriteContext): Promise<void> {
  const operation: RepoOperation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
  if (operation !== null && operation !== 'bisect') {
    throw new GitCommandFailure('git/operation-in-progress', `a ${operation} is in progress`, { operation })
  }
}

/** Whether any of the named hooks exists and is executable (honors `core.hooksPath`). */
export async function hasHook(ctx: WriteContext, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    const result = await query(ctx, ['rev-parse', '--git-path', `hooks/${name}`])
    if (result.exitCode !== 0) continue
    const relative = result.stdout.trim()
    if (relative === '') continue
    const path = isAbsolute(relative) ? relative : join(ctx.repoRoot, relative)
    try {
      await access(path, constants.X_OK)
      return true
    } catch {
      // Not present or not executable: git skips it too.
    }
  }
  return false
}

/** Redacted, byte-bounded combined output for error details. */
export function outputSummary(result: GitRunResult, maxBytes = HOOK_OUTPUT_MAX_BYTES): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== '').join('\n')
  return truncateConsoleOutput(redactCredentials(combined), maxBytes).text
}

/** {@link failureFromExit} with credentials removed from the message and details. */
export function redactedFailure(result: GitRunResult, label: string): GitCommandFailure {
  const failure = failureFromExit(result, label)
  const details = { ...failure.details }
  if (typeof details.stderr === 'string') details.stderr = redactCredentials(details.stderr)
  return new GitCommandFailure(failure.code, redactCredentials(failure.message), details)
}

/** First matching line of a git diagnostic, redacted. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return redactCredentials(line.trim())
}

const AUTH_PATTERNS: readonly RegExp[] = [
  /could not read (Username|Password)/i,
  /terminal prompts disabled/i,
  /Authentication failed/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /HTTP Basic: Access denied/i,
  /Invalid username or password/i,
]

/** Whether stderr reports a credential/interactive-auth failure. */
export function isAuthFailure(stderr: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(stderr))
}

/** Sandbox denial markers (references §13): checked before any other classification. */
export function isSandboxDenial(text: string): boolean {
  return /Operation not permitted/i.test(text) || /unable to create temporary object directory/i.test(text)
}

/** POSIX single-quoted shell word. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * A copy-pasteable terminal command (`cd <repo> && git ...`) for `git/auth-required`.
 * Arguments are names chosen by the user, never URLs, and are redacted anyway.
 */
export function terminalCommand(repoRoot: string, gitArgs: readonly string[]): string {
  const words = ['git', ...gitArgs].map((word) => shellQuote(redactCredentials(word)))
  return `cd ${shellQuote(repoRoot)} && ${words.join(' ')}`
}

/** `git/auth-required` with a credential-free terminal command. */
export function authRequired(result: GitRunResult, repoRoot: string, gitArgs: readonly string[]): GitCommandFailure {
  return new GitCommandFailure('git/auth-required', firstLine(result.stderr) || 'authentication required', {
    command: terminalCommand(repoRoot, gitArgs),
    stderr: redactCredentials(result.stderr.trim()).slice(0, 2000),
  })
}

/**
 * Paths per argv batch for commands without `--pathspec-from-file` (`clean`, `status`).
 * 200 × the 4096-byte PATH_MAX stays below 1MiB (macOS ARG_MAX); real paths are far shorter
 * (A3 T1 spike: 200 × 600-byte paths cleaned in one confined call).
 */
export const CLEAN_BATCH_MAX = 200

/** Pathspec delivered on stdin (A3 T1, TD-9): no path ever lands in argv, so ARG_MAX cannot bite. */
export interface PathspecInput {
  /** Append after the subcommand's options; replaces `-- <paths...>`. */
  args: readonly ['--pathspec-from-file=-', '--pathspec-file-nul']
  /** NUL-terminated paths; literal because `GIT_LITERAL_PATHSPECS=1` is set for writes. */
  stdin: string
}

/**
 * `--pathspec-from-file=- --pathspec-file-nul` + the NUL-terminated list, for `add`, `commit`,
 * `restore`, `reset`, `checkout`, `rm` and `stash push` (references §13, A3 spike).
 * Paths come from {@link parseWritePaths} (validated, no NUL), so the encoding is unambiguous.
 */
export function pathspecArgs(paths: readonly string[]): PathspecInput {
  return {
    args: ['--pathspec-from-file=-', '--pathspec-file-nul'],
    stdin: paths.map((path) => `${path}\0`).join(''),
  }
}

/** Split a list into consecutive batches of at most `size` items. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/** Index (`x`) and worktree (`y`) status letters of one path; `??` is untracked. */
export interface PathState {
  x: string
  y: string
}

/**
 * Status of exactly the given paths (`status --porcelain=v1 -z --no-renames`, all untracked
 * files listed individually). A path absent from the map has no change at all.
 * `status` has no `--pathspec-from-file`, so long lists run in {@link CLEAN_BATCH_MAX} batches.
 */
export async function readPathStates(ctx: WriteContext, paths: readonly string[]): Promise<Map<string, PathState>> {
  const states = new Map<string, PathState>()
  for (const batch of batches(paths, CLEAN_BATCH_MAX)) {
    const stdout = await queryOk(
      ctx,
      ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none', '--', ...batch],
      'git status',
    )
    for (const record of stdout.split('\0')) {
      if (record.length < 4 || record[2] !== ' ') continue
      states.set(record.slice(3), { x: record[0] ?? ' ', y: record[1] ?? ' ' })
    }
  }
  return states
}

/** Current HEAD as `{ sha, shortSha }`. */
export async function readHead(ctx: WriteContext): Promise<{ sha: string; shortSha: string }> {
  const stdout = await queryOk(ctx, ['log', '-1', '--format=%H%x1f%h', 'HEAD'], 'git log HEAD')
  const [sha = '', shortSha = ''] = stdout.trim().split('\u001f')
  if (sha === '') throw new GitCommandFailure('git/exec-failed', 'could not resolve HEAD')
  return { sha, shortSha }
}

/** Configured remote names. */
export async function readRemotes(ctx: WriteContext): Promise<string[]> {
  const stdout = await queryOk(ctx, ['remote'], 'git remote')
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Validate `remote` against the configured remotes and `branch` with `check-ref-format`. */
export async function assertPushTarget(ctx: WriteContext, remote: string, branch: string): Promise<void> {
  const remotes = await readRemotes(ctx)
  if (!remotes.includes(remote)) throw invalidPayload(`unknown remote "${remote}"`, { remote })
  const check = await query(ctx, ['check-ref-format', `refs/heads/${branch}`])
  if (check.exitCode !== 0) throw invalidPayload(`invalid branch name "${branch}"`, { branch })
}
