// git 执行层：唯一允许碰 ctx.subprocess 的地方（可行性调研 §8）。
// 只接受 argv 数组（不经 shell），清掉继承的仓库选择器，输出超限就整体失败，
// 绝不把半截输出交给解析层。

import { tmpdir } from 'node:os'

import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

import { GIT_NETWORK_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from '../shared/protocol.ts'
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

/**
 * Write/network environment (A2 T1 spike, references §13「写执行与沙箱」):
 * - same selector tombstones, no prompts, literal pathspecs, stable locale;
 * - system config stays visible: it carries user intent such as the credential helper;
 * - `GIT_OPTIONAL_LOCKS` is removed (tombstoned) so an inherited value cannot leak in;
 * - no credential UI of any kind (评审 I5): an empty `GIT_ASKPASS` makes git skip askpass
 *   entirely (including `core.askPass`/`SSH_ASKPASS` inherited from e.g. an IDE terminal),
 *   OpenSSH never asks, Git Credential Manager stays non-interactive;
 * - no editor: nothing should open one, `true` makes any accidental request succeed silently.
 */
export const GIT_WRITE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  ...Object.fromEntries(CLEARED_GIT_ENV_KEYS.map((key) => [key, undefined])),
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: undefined,
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
  GIT_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  GCM_INTERACTIVE: 'never',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
})

/**
 * {@link GIT_WRITE_ENV} for `git rebase -i` driven by a todo on stdin (plan b3a): git runs the
 * sequence editor as `sh -c 'cat > "$@"'`, so the todo the Host wrote to stdin replaces git's own.
 * The environment variable is needed because it outranks `-c sequence.editor` (b3a T3).
 */
export const GIT_TODO_STDIN_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  ...GIT_WRITE_ENV,
  GIT_SEQUENCE_EDITOR: 'cat >',
})

/** Execution class of one command: decides timeout, environment and confinement. */
export type GitRunMode = 'read' | 'write' | 'network'

/** Default deadline for a mode (设计 §16.4: read 8s, local write 60s, network 180s). */
export function timeoutForMode(mode: GitRunMode): number {
  if (mode === 'write') return GIT_WRITE_TIMEOUT_MS
  if (mode === 'network') return GIT_NETWORK_TIMEOUT_MS
  return GIT_TIMEOUT_MS
}

/**
 * How a write/network command is confined. `unconfined` exists only for
 * `danger-full-access` sessions; anything else must wrap the argv in `sandbox.confine`.
 * A write without a confiner is refused before spawning (fail closed).
 */
export type GitConfiner =
  | { kind: 'confined'; wrap: (argv: readonly string[], signal: AbortSignal) => Promise<readonly string[]> }
  | { kind: 'unconfined' }

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
  /** Defaults to `read`; `write`/`network` require {@link GitRunOptions.confine}. */
  mode?: GitRunMode | undefined
  /** Confinement for write/network commands; ignored in read mode. */
  confine?: GitConfiner | undefined
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  stderrMaxBytes?: number | undefined
  /**
   * Bytes for the child's stdin (A3 T1: `--pathspec-from-file=-`, `commit -F -`).
   * Present → `stdio.stdin: 'pipe'`, written in full and closed right after spawn;
   * absent → `'ignore'` (fd 0 on /dev/null), so git can never wait on input.
   */
  stdin?: string | Uint8Array | undefined
  /** B3a: stdin is a rebase todo ({@link GIT_TODO_STDIN_ENV}); write/network mode with stdin only. */
  todoFromStdin?: boolean | undefined
}

/** Byte length of a stdin payload (console records only the size, never the content). */
export function stdinByteLength(stdin: string | Uint8Array): number {
  return typeof stdin === 'string' ? Buffer.byteLength(stdin, 'utf8') : stdin.byteLength
}

/** Executor-level defaults, fixed when the plugin is applied. */
export interface GitRunnerDefaults {
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  stderrMaxBytes?: number | undefined
  /**
   * B4c T2: probe `git --exec-path` once and run the `git` binary found there. The PATH `git`
   * can be a launcher (macOS `/usr/bin/git` goes through xcrun) that costs 5–40ms per spawn.
   * Falls back to the PATH result when the probe finds nothing. The probe owns its deadline and
   * cwd, so one caller's cancellation never fails the others; a probe that timed out or could not
   * spawn is not cached. A cached binary is re-checked before each use (a `brew upgrade git`
   * removes the old Cellar path) and re-probed when it is gone.
   */
  directBinary?: boolean | undefined
  /**
   * B4d T2: a user-set git path (see git-executable.ts). When it returns a path, every command
   * runs exactly that program (checked before each use) and `directBinary` is not consulted.
   */
  executable?: { override(): string | null } | undefined
}

/** Name of the git binary inside `--exec-path`. */
function directBinaryName(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git'
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
    : /index\.lock'?: File exists/i.test(stderr)
      ? 'git/locked'
      : /Operation not permitted/i.test(stderr)
        ? 'git/sandbox-denied'
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
  /** Shared direct-binary decision (B4c T2); cleared when a probe did not settle or the binary vanished. */
  let directProgram: Promise<string> | undefined

  /** The probe's own outcome: `settled: false` means "use this once, do not cache". */
  const probeDirect = async (fallback: string): Promise<{ program: string; settled: boolean }> => {
    const signal = AbortSignal.timeout(defaultTimeoutMs)
    let child: SubprocessHandle
    try {
      // `--exec-path` does not depend on the repository: a fixed, existing cwd keeps a caller's
      // missing directory from failing the probe for everybody (final review I3).
      child = subprocess.spawn({
        argv: [fallback, '--exec-path'],
        cwd: tmpdir(),
        env: GIT_READ_ENV,
        signal,
        graceMs: GIT_GRACE_MS,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      })
    } catch {
      return { program: fallback, settled: false }
    }
    try {
      const outcome = await child.done.catch(() => null)
      // A killed or failed probe exits too: never settle the decision on such a run.
      if (outcome === null || signal.aborted) return { program: fallback, settled: false }
      const dir = outcome.exitCode === 0 ? (child.collected.stdout?.readFrom(0).text ?? '').trim() : ''
      if (dir === '') return { program: fallback, settled: true }
      try {
        return { program: await subprocess.resolveExecutable(`${dir}/${directBinaryName()}`, undefined, signal), settled: true }
      } catch {
        return { program: fallback, settled: !signal.aborted }
      }
    } finally {
      child.terminate()
      await child.waitForExit().catch(() => false)
    }
  }

  /** Wait for `promise` unless the caller's `signal` aborts first (the shared work keeps running). */
  const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const onAbort = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
    })

  /** Bumped per probe, so a finished probe only clears the cache it created. */
  let probeGeneration = 0

  const sharedDirect = (): Promise<string> => {
    if (directProgram === undefined) {
      const generation = ++probeGeneration
      const forget = (): void => {
        if (probeGeneration === generation) directProgram = undefined
      }
      // Assigned before any await, so concurrent first callers share one probe.
      directProgram = (async () => {
        const fallback = await subprocess.resolveExecutable('git', undefined, AbortSignal.timeout(defaultTimeoutMs))
        const { program, settled } = await probeDirect(fallback)
        if (!settled) forget()
        return program
      })()
      directProgram.catch(forget)
    }
    return directProgram
  }

  const resolveProgram = async (signal: AbortSignal): Promise<string> => {
    const override = defaults.executable?.override() ?? null
    if (override !== null) {
      await subprocess.resolveExecutable(override, undefined, signal)
      return override
    }
    if (defaults.directBinary !== true) return subprocess.resolveExecutable('git', undefined, signal)
    const cached = directProgram
    const program = await untilAborted(sharedDirect(), signal)
    if (cached === undefined) return program
    // A binary cached by an earlier probe may have been removed since (final review I2).
    try {
      await subprocess.resolveExecutable(program, undefined, signal)
      return program
    } catch (error) {
      if (signal.aborted) throw error
      if (directProgram === cached) {
        directProgram = undefined
        probeGeneration += 1
      }
      return untilAborted(sharedDirect(), signal)
    }
  }

  return async function runGit(argv, options) {
    const mode = options.mode ?? 'read'
    if (options.todoFromStdin === true && (mode === 'read' || options.stdin === undefined)) {
      throw new GitCommandFailure('git/invalid-payload', 'todoFromStdin needs stdin and a write mode', { argv: [...argv] })
    }
    const timeoutMs = options.timeoutMs ?? (mode === 'read' ? defaultTimeoutMs : timeoutForMode(mode))
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
      program = await resolveProgram(lifetime)
    } catch (error) {
      // Not an abort → there is no git to run (design §16.7 `git/not-found`, B4d T2).
      const aborted = classifyAbort(error).code
      throw new GitCommandFailure(
        aborted === 'git/exec-failed' && options.signal?.aborted !== true ? 'git/not-found' : aborted,
        `git executable unavailable: ${messageOf(error)}`,
        { argv: [...argv], cwd: options.cwd },
      )
    }

    let command: readonly string[] = [program, ...argv]
    if (mode !== 'read') {
      const confine = options.confine
      if (confine === undefined) {
        throw new GitCommandFailure('git/sandbox-denied', 'write command has no sandbox confinement (fail closed)', {
          argv: [...argv],
        })
      }
      if (confine.kind === 'confined') {
        try {
          command = await confine.wrap(command, lifetime)
        } catch (error) {
          const aborted = classifyAbort(error)
          if (aborted.code === 'git/timeout' || aborted.details?.cancelled === true) throw aborted
          throw new GitCommandFailure('git/sandbox-denied', `sandbox confine failed: ${messageOf(error)}`, {
            argv: [...argv],
          })
        }
      }
    }

    let child: SubprocessHandle
    try {
      child = subprocess.spawn({
        argv: [...command],
        cwd: options.cwd,
        env: mode === 'read' ? GIT_READ_ENV : options.todoFromStdin === true ? GIT_TODO_STDIN_ENV : GIT_WRITE_ENV,
        signal: lifetime,
        graceMs: GIT_GRACE_MS,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : 'pipe',
          stdout: { maxBytes: stdoutMaxBytes },
          stderr: { maxBytes: stderrMaxBytes },
        },
      })
    } catch (error) {
      throw classifyAbort(error)
    }

    if (options.stdin !== undefined) {
      const input = child.stdin
      if (input === undefined) {
        // Never let git run on an empty stdin: an empty `--pathspec-from-file=-` means "no
        // pathspec", e.g. `reset -q` unstages the whole index, `commit --only --amend` amends
        // the message only. Kill the child before it can act and fail the call.
        child.terminate()
        await child.waitForExit().catch(() => false)
        throw new GitCommandFailure('git/exec-failed', 'subprocess did not provide a stdin pipe', {
          argv: [...argv],
        })
      }
      // A child that exits without reading (bad option, early failure) closes the pipe:
      // EPIPE is expected then and the exit facts carry the real failure.
      input.on('error', () => undefined)
      input.end(options.stdin)
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
 * What a write operation sees: the repository, the request's cancellation, and a
 * git function already bound to the repository and the session's confinement.
 * Write operations (src/host/git/*-write) receive this instead of the raw runner.
 */
export interface WriteContext {
  readonly repoRoot: string
  readonly signal: AbortSignal
  /** Run git in the repository; `mode` defaults to `write` (confined). */
  git: (
    argv: readonly string[],
    options?: {
      mode?: GitRunMode
      timeoutMs?: number
      stdoutMaxBytes?: number
      stdin?: string | Uint8Array
      todoFromStdin?: boolean
    },
  ) => Promise<GitRunResult>
}

/**
 * One write endpoint: `parse` validates the payload (throwing `git/invalid-payload`)
 * before the gate is evaluated; `run` executes under the write queue and gate.
 * The RPC layer adds `version` to the returned value.
 */
export interface WriteOperation<I, V extends object> {
  parse(payload: unknown): I
  // Method syntax on purpose: the RPC table stores operations with differing input types.
  run(ctx: WriteContext, input: I): Promise<V>
}

/** Bind a runner to one repository, confinement and request signal. */
export function bindWriteContext(
  run: GitRunner,
  repoRoot: string,
  confine: GitConfiner,
  signal: AbortSignal,
): WriteContext {
  return {
    repoRoot,
    signal,
    git: (argv, options = {}) =>
      run(argv, {
        cwd: repoRoot,
        signal,
        confine,
        mode: options.mode ?? 'write',
        timeoutMs: options.timeoutMs,
        stdoutMaxBytes: options.stdoutMaxBytes,
        stdin: options.stdin,
        todoFromStdin: options.todoFromStdin,
      }),
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
    const stdinBytes = options.stdin === undefined ? undefined : stdinByteLength(options.stdin)
    try {
      const result = await run(argv, options)
      recorder.record({
        argv,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdinBytes,
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
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        // A thrown failure carries no exit facts except those the executor attached.
        exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
        stdout: detailText('stdout'),
        stderr: detailText('stderr') || (failure?.message ?? messageOf(error)),
        cancelled: details.cancelled === true,
        timedOut: failure?.code === 'git/timeout',
        // The collected stream lost its head before the executor refused to parse it.
        stdoutTruncated: failure?.code === 'git/output-too-large',
        stdinBytes,
      })
      throw error
    }
  }
}
