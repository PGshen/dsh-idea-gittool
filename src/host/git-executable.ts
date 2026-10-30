// Which git the Host runs (B4d T2, design §7.2 / settings「git 路径」, decision 1).
// - Default: `git` resolved on PATH. A user-set absolute path overrides it in this process's memory
//   only (never written to disk); the client re-sends its stored setting after a Host restart.
// - A path is adopted only after it passes, in this order (final review I1, ADR 0014): absolute and
//   local (no UNC on Windows); named `git`/`git.exe` both as given and after realpath; the real
//   file lies outside the session's workspace (an agent there could have planted it); an executable
//   regular file — all before anything runs — then `--version` prints `git version …` of at least
//   GIT_MIN_VERSION. The real path is what runs, and its identity (device, inode, size, mtime) is
//   re-checked before every command: a replaced file stops being run.
// - `info()` memoizes the successful probe; a failed one is retried on the next call. The probe has
//   its own deadline, so one caller's cancellation never fails the others.
// - Overlapping `set()` calls: the latest one wins; an earlier one still validating fails with
//   `git/stale-target` (`target: 'git-path'`) instead of adopting its path afterwards.
// - `snapshot()` (t2 T5): a write freezes the choice when it starts, so a `set()` mid-way never
//   switches git between its commands; only read-write sessions may call `set()` (rpc gate).

import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'

import type { GitExecutableInfo, UnsupportedVersionDetails } from '../shared/protocol.ts'
import type { GitProgramSource, GitSubprocess } from './git-executor.ts'
import { GIT_GRACE_MS, GIT_READ_ENV, GIT_TIMEOUT_MS, GitCommandFailure, messageOf } from './git-executor.ts'
import { GIT_MIN_VERSION, formatGitVersion, isSupportedGitVersion, parseGitVersion } from './git-version.ts'
import { isWithinRoot } from './sandbox-gate.ts'

export type GitPathRejection = 'not-absolute' | 'not-local' | 'not-found' | 'not-executable' | 'not-git' | 'inside-workspace'

export interface GitExecutable extends GitProgramSource {
  /** The user-set path in effect, or null for PATH. Read by the runner before every command. */
  override(): string | null
  /** Whether the adopted file is still the one that was validated (true when none is set). */
  verify(): Promise<boolean>
  /**
   * The current choice frozen (t2 T5): a later `set()` does not change it, so one write runs a
   * single git from start to end. `verify()` still re-checks the pinned file identity per command.
   */
  snapshot(): Required<GitProgramSource>
  /** The git in use; throws `git/not-found` when PATH has none (or the set path vanished). */
  info(signal: AbortSignal): Promise<GitExecutableInfo>
  /** Validate and adopt `path` (null → back to PATH); always re-probes. The old path stays on rejection. */
  set(path: string | null, signal: AbortSignal, options?: { forbiddenRoots?: readonly string[] }): Promise<GitExecutableInfo>
}

export interface GitExecutableOptions {
  /** Test seam: path rules of this platform (defaults to the Host's). */
  platform?: NodeJS.Platform
}

interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

const GIT_NAMES = new Set(['git', 'git.exe'])

function rejected(reason: GitPathRejection, message: string): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, { reason })
}

function notFound(message: string): GitCommandFailure {
  return new GitCommandFailure('git/not-found', message, {})
}

/** Wait for `promise` unless `signal` aborts first (the shared work keeps running). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

export function createGitExecutable(subprocess: GitSubprocess, options: GitExecutableOptions = {}): GitExecutable {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix
  let override: string | null = null
  let identity: FileIdentity | null = null
  let probe: Promise<GitExecutableInfo> | undefined
  /** Bumped by every `set()`; a validation that finishes after a newer call began is discarded. */
  let generation = 0

  /** `<program> --version` stdout, or null when it could not run or exited non-zero. */
  const versionOutput = async (program: string, signal: AbortSignal): Promise<string | null> => {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)])
    let child
    try {
      child = subprocess.spawn({
        argv: [program, '--version'],
        cwd: tmpdir(),
        env: GIT_READ_ENV,
        signal: lifetime,
        graceMs: GIT_GRACE_MS,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      })
    } catch {
      return null
    }
    try {
      const outcome = await child.done.catch(() => null)
      signal.throwIfAborted()
      if (outcome === null || outcome.exitCode !== 0) return null
      return (child.collected.stdout?.readFrom(0).text ?? '').trim()
    } finally {
      child.terminate()
      await child.waitForExit().catch(() => false)
    }
  }

  const detect = async (signal: AbortSignal): Promise<GitExecutableInfo> => {
    const source = override === null ? 'path' : 'setting'
    let path: string
    try {
      path = override ?? (await subprocess.resolveExecutable('git', undefined, signal))
      if (override !== null) await subprocess.resolveExecutable(override, undefined, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw notFound(`git executable not found: ${messageOf(error)}`)
    }
    const raw = await versionOutput(path, signal)
    const parsed = raw === null ? null : parseGitVersion(raw)
    if (raw === null || parsed === null) {
      throw new GitCommandFailure('git/exec-failed', `${path} --version did not report a git version`, { path })
    }
    return { path, version: formatGitVersion(parsed), raw, source }
  }

  const info = (signal: AbortSignal): Promise<GitExecutableInfo> => {
    if (probe === undefined) {
      const current = detect(AbortSignal.timeout(GIT_TIMEOUT_MS))
      probe = current
      current.catch(() => {
        if (probe === current) probe = undefined
      })
    }
    return untilAborted(probe, signal)
  }

  const identityOf = async (path: string): Promise<FileIdentity | null> => {
    const facts = await stat(path).catch(() => null)
    return facts === null ? null : { dev: facts.dev, ino: facts.ino, size: facts.size, mtimeMs: facts.mtimeMs }
  }

  const validate = async (given: string, forbiddenRoots: readonly string[], signal: AbortSignal): Promise<{ info: GitExecutableInfo; identity: FileIdentity }> => {
    if (!pathApi.isAbsolute(given)) throw rejected('not-absolute', 'the git path must be absolute')
    if (platform === 'win32' && /^[\\/]{2}/u.test(given)) throw rejected('not-local', 'the git path must be on a local drive')
    const isGitName = (path: string): boolean => GIT_NAMES.has(pathApi.basename(path).toLowerCase())
    if (!isGitName(given)) throw rejected('not-git', `${given} is not named git`)
    const path = await realpath(given).catch(() => null)
    if (path === null) throw rejected('not-found', `${given} does not exist`)
    if (!isGitName(path)) throw rejected('not-git', `${given} resolves to ${path}, which is not named git`)
    for (const root of forbiddenRoots) {
      const canonicalRoot = await realpath(root).catch(() => root)
      if (isWithinRoot(canonicalRoot, path, pathApi)) throw rejected('inside-workspace', `${path} is inside the session workspace`)
    }
    const facts = await stat(path).catch(() => null)
    if (facts === null) throw rejected('not-found', `${given} does not exist`)
    if (!facts.isFile()) throw rejected('not-executable', `${given} is not a file`)
    if (!(await access(path, constants.X_OK).then(() => true, () => false))) {
      throw rejected('not-executable', `${given} is not executable`)
    }
    const pinned: FileIdentity = { dev: facts.dev, ino: facts.ino, size: facts.size, mtimeMs: facts.mtimeMs }
    const raw = await versionOutput(path, signal)
    const parsed = raw !== null && /^git version /u.test(raw) ? parseGitVersion(raw) : null
    if (raw === null || parsed === null) throw rejected('not-git', `${path} --version does not print a git version`)
    if (!isSupportedGitVersion(parsed)) {
      const details: UnsupportedVersionDetails = { current: formatGitVersion(parsed), minimum: GIT_MIN_VERSION }
      throw new GitCommandFailure('git/unsupported-version', `git ${details.current} is older than ${GIT_MIN_VERSION}`, { ...details })
    }
    return { info: { path, version: formatGitVersion(parsed), raw, source: 'setting' }, identity: pinned }
  }

  /** Whether `path` is still the file pinned as `pinned` (true when nothing is set). */
  const unchanged = async (path: string | null, pinned: FileIdentity | null): Promise<boolean> => {
    if (path === null || pinned === null) return true
    const now = await identityOf(path)
    return now !== null && now.dev === pinned.dev && now.ino === pinned.ino && now.size === pinned.size && now.mtimeMs === pinned.mtimeMs
  }

  return {
    override: () => override,
    verify: () => unchanged(override, identity),
    snapshot() {
      const frozenPath = override
      const frozenIdentity = identity
      return Object.freeze({
        override: () => frozenPath,
        verify: () => unchanged(frozenPath, frozenIdentity),
      })
    },
    info,
    async set(path, signal, setOptions = {}) {
      // The latest call wins: a call still validating when a later one starts must not adopt its
      // path afterwards (T1-T4), and it does not report success for a path that is not in effect.
      generation += 1
      const mine = generation
      if (path === null) {
        override = null
        identity = null
        probe = undefined
        return await info(signal)
      }
      const adopted = await validate(path, setOptions.forbiddenRoots ?? [], signal)
      if (mine !== generation) {
        throw new GitCommandFailure('git/stale-target', `a later git path setting replaced ${path}`, { target: 'git-path', expected: path })
      }
      override = adopted.info.path
      identity = adopted.identity
      probe = Promise.resolve(adopted.info)
      return adopted.info
    },
  }
}
