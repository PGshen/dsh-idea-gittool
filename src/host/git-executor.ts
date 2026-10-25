// git 执行层：唯一允许碰 ctx.subprocess 的地方（可行性调研 §8）。
// 只接受 argv 数组（不经 shell），清掉继承的仓库选择器，输出超限就整体失败，
// 绝不把半截输出交给解析层。

import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

import type { GitErrorCode } from '../shared/protocol.ts'
import type { GitConsole } from './console.ts'

/** Default deadline for one read-only git command. */
export const GIT_TIMEOUT_MS = 8000
/** Bounded stdout; a lossy read aborts the command instead of parsing a truncated stream. */
export const GIT_STDOUT_MAX_BYTES = 2 * 1024 * 1024
/** Bounded stderr; only used for diagnostics, never for data. */
export const GIT_STDERR_MAX_BYTES = 64 * 1024
/** Grace period handed to the subprocess seam's termination ladder. */
export const GIT_GRACE_MS = 2000

/**
 * Inherited git "selectors": if any survive from the Host process, git resolves
 * a different repository than the session cwd (`GIT_DIR`, work trees, alternates).
 * Tombstoned to `undefined` so the seam removes them from the child environment.
 */
export const CLEARED_GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_ATTR_SOURCE',
] as const

/**
 * Read-only git environment (可行性调研 §8.2):
 * - `GIT_CONFIG_COUNT=0` also drops inherited `GIT_CONFIG_KEY_n` pairs;
 * - no system config, no interactive prompts, no index lock writes;
 * - literal pathspecs so a path containing `*` is never a glob;
 * - `LC_ALL=C` keeps diagnostics stable for classification.
 */
export const GIT_READ_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  ...Object.fromEntries(CLEARED_GIT_ENV_KEYS.map((key) => [key, undefined])),
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
})

/** Global arguments every read-only command starts with (argv, never a shell string). */
export const GIT_BASE_ARGV: readonly string[] = ['--no-pager', '-c', 'core.fsmonitor=false']

/** Structural subset of `ctx.subprocess` consumed here (keeps tests seam-shaped). */
export interface GitSubprocess {
  resolveExecutable: SubprocessRuntime['resolveExecutable']
  spawn: SubprocessRuntime['spawn']
}

/** One spawned command's facts. A non-zero exit is data, not a thrown error. */
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Per-call overrides of the executor defaults. */
export interface GitRunOptions {
  cwd: string
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  stderrMaxBytes?: number | undefined
}

/** Executor-level defaults, fixed when the plugin is applied. */
export interface GitRunnerDefaults {
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  stderrMaxBytes?: number | undefined
}

/** One git invocation boundary: argv + completely specified execution world. */
export type GitRunner = (argv: readonly string[], options: GitRunOptions) => Promise<GitRunResult>

/** A structured, already-classified git failure. Never escapes the RPC handler as a throw. */
export class GitCommandFailure extends Error {
  readonly code: GitErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: GitErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'GitCommandFailure'
    this.code = code
    this.details = details
  }
}

/** Human-readable text for an unknown rejection, for structured error messages. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Classify a completed-but-failing command from its exit facts. */
export function failureFromExit(result: GitRunResult, label: string): GitCommandFailure {
  const stderr = result.stderr.trim()
  const firstLine = stderr.split('\n').find((line) => line.trim() !== '')
  const message = firstLine ?? `${label} exited with ${String(result.exitCode)}`
  const code: GitErrorCode = /not a git repository/i.test(stderr)
    ? 'git/not-a-repository'
    : 'git/exec-failed'
  return new GitCommandFailure(code, message, {
    exitCode: result.exitCode,
    stderr: stderr.slice(0, 2000),
  })
}

/** Build a git runner bound to one subprocess provider. */
export function createGitRunner(
  subprocess: GitSubprocess,
  defaults: GitRunnerDefaults = {},
): GitRunner {
  const defaultTimeoutMs = defaults.timeoutMs ?? GIT_TIMEOUT_MS
  const defaultStdoutMaxBytes = defaults.stdoutMaxBytes ?? GIT_STDOUT_MAX_BYTES
  const defaultStderrMaxBytes = defaults.stderrMaxBytes ?? GIT_STDERR_MAX_BYTES

  return async function runGit(argv, options) {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    const stdoutMaxBytes = options.stdoutMaxBytes ?? defaultStdoutMaxBytes
    const stderrMaxBytes = options.stderrMaxBytes ?? defaultStderrMaxBytes
    const deadline = AbortSignal.timeout(timeoutMs)
    const lifetime =
      options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

    const cancelled = (): GitCommandFailure =>
      new GitCommandFailure('git/exec-failed', 'git command cancelled by the caller', {
        cancelled: true,
        argv: [...argv],
      })
    const timedOut = (): GitCommandFailure =>
      new GitCommandFailure('git/timeout', `git command exceeded ${String(timeoutMs)} ms`, {
        timeoutMs,
        argv: [...argv],
      })
    /** Abort cause wins over spawn/transport failures: the caller owns the deadline. */
    const classifyAbort = (error: unknown): GitCommandFailure => {
      if (options.signal?.aborted === true) return cancelled()
      if (deadline.aborted) return timedOut()
      return new GitCommandFailure('git/exec-failed', `git command failed to run: ${messageOf(error)}`, {
        argv: [...argv],
        cwd: options.cwd,
      })
    }

    let program: string
    try {
      program = await subprocess.resolveExecutable('git', undefined, lifetime)
    } catch (error) {
      throw new GitCommandFailure(
        classifyAbort(error).code,
        `git executable unavailable: ${messageOf(error)}`,
        { argv: [...argv], cwd: options.cwd },
      )
    }

    let child: SubprocessHandle
    try {
      child = subprocess.spawn({
        argv: [program, ...argv],
        cwd: options.cwd,
        env: GIT_READ_ENV,
        signal: lifetime,
        graceMs: GIT_GRACE_MS,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: stdoutMaxBytes },
          stderr: { maxBytes: stderrMaxBytes },
        },
      })
    } catch (error) {
      throw classifyAbort(error)
    }

    try {
      let outcome: Awaited<SubprocessHandle['done']>
      try {
        outcome = await child.done
      } catch (error) {
        throw classifyAbort(error)
      }
      if (options.signal?.aborted === true) throw cancelled()
      if (deadline.aborted) throw timedOut()

      const stdout = child.collected.stdout?.readFrom(0)
      const stderr = child.collected.stderr?.readFrom(0)
      if (stdout?.lossy === true) {
        throw new GitCommandFailure(
          'git/output-too-large',
          `git output exceeded ${String(stdoutMaxBytes)} bytes; refusing to parse a truncated stream`,
          { stdoutMaxBytes, argv: [...argv] },
        )
      }
      return {
        exitCode: outcome.exitCode,
        stdout: stdout?.text ?? '',
        stderr: stderr?.text ?? '',
      }
    } finally {
      child.terminate()
      await child.waitForExit().catch(() => false)
    }
  }
}

/**
 * Wrap a runner so every call lands in the Git console (设计 §12).
 *
 * This is the single埋点 point for the Host half: read commands, writes (A2/A3),
 * timeouts, cancellations and lossy-output failures are all recorded with the
 * facts the console needs. The wrapper never changes the runner's contract —
 * results pass through untouched and failures are rethrown by identity.
 */
export function instrumentGitRunner(run: GitRunner, recorder: GitConsole): GitRunner {
  return async function instrumentedGitRunner(argv, options) {
    const startedAt = Date.now()
    try {
      const result = await run(argv, options)
      recorder.record({
        argv,
        durationMs: Date.now() - startedAt,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      })
      return result
    } catch (error) {
      const failure = error instanceof GitCommandFailure ? error : undefined
      const details = failure?.details ?? {}
      const detailText = (key: string): string => {
        const value = details[key]
        return typeof value === 'string' ? value : ''
      }
      recorder.record({
        argv,
        durationMs: Date.now() - startedAt,
        // A thrown failure carries no exit facts except those the executor attached.
        exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
        stdout: detailText('stdout'),
        stderr: detailText('stderr') || (failure?.message ?? messageOf(error)),
        cancelled: details.cancelled === true,
        timedOut: failure?.code === 'git/timeout',
        // The collected stream lost its head before the executor refused to parse it.
        stdoutTruncated: failure?.code === 'git/output-too-large',
      })
      throw error
    }
  }
}
