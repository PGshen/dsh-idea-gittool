// Which git the Host runs (B4d T2, design §7.2 / settings「git 路径」, decision 1).
// - Default: `git` resolved on PATH. A user-set absolute path overrides it in this process's memory
//   only (never written to disk); the client re-sends its stored setting after a Host restart.
// - A path is adopted only after it passes: absolute, an executable file, `--version` prints
//   `git version …`, and that version is at least GIT_MIN_VERSION.
// - `info()` memoizes the successful probe; a failed one is retried on the next call.

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'

import type { GitExecutableInfo, UnsupportedVersionDetails } from '../shared/protocol.ts'
import type { GitSubprocess } from './git-executor.ts'
import { GIT_GRACE_MS, GIT_READ_ENV, GIT_TIMEOUT_MS, GitCommandFailure, messageOf } from './git-executor.ts'
import { GIT_MIN_VERSION, formatGitVersion, isSupportedGitVersion, parseGitVersion } from './git-version.ts'

export type GitPathRejection = 'not-absolute' | 'not-found' | 'not-executable' | 'not-git'

export interface GitExecutable {
  /** The user-set path in effect, or null for PATH. Read by the runner before every command. */
  override(): string | null
  /** The git in use; throws `git/not-found` when PATH has none (or the set path vanished). */
  info(signal: AbortSignal): Promise<GitExecutableInfo>
  /** Validate and adopt `path` (null → back to PATH); always re-probes. The old path stays on rejection. */
  set(path: string | null, signal: AbortSignal): Promise<GitExecutableInfo>
}

function rejected(reason: GitPathRejection, message: string): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, { reason })
}

function notFound(message: string): GitCommandFailure {
  return new GitCommandFailure('git/not-found', message, {})
}

export function createGitExecutable(subprocess: GitSubprocess): GitExecutable {
  let override: string | null = null
  let probe: Promise<GitExecutableInfo> | undefined

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
      const current = detect(signal)
      probe = current
      current.catch(() => {
        if (probe === current) probe = undefined
      })
    }
    return probe
  }

  const validate = async (path: string, signal: AbortSignal): Promise<GitExecutableInfo> => {
    if (!isAbsolute(path)) throw rejected('not-absolute', 'the git path must be absolute')
    const facts = await stat(path).catch(() => null)
    if (facts === null) throw rejected('not-found', `${path} does not exist`)
    if (!facts.isFile()) throw rejected('not-executable', `${path} is not a file`)
    if (!(await access(path, constants.X_OK).then(() => true, () => false))) {
      throw rejected('not-executable', `${path} is not executable`)
    }
    const raw = await versionOutput(path, signal)
    const parsed = raw !== null && /^git version /u.test(raw) ? parseGitVersion(raw) : null
    if (raw === null || parsed === null) throw rejected('not-git', `${path} --version does not print a git version`)
    if (!isSupportedGitVersion(parsed)) {
      const details: UnsupportedVersionDetails = { current: formatGitVersion(parsed), minimum: GIT_MIN_VERSION }
      throw new GitCommandFailure('git/unsupported-version', `git ${details.current} is older than ${GIT_MIN_VERSION}`, { ...details })
    }
    return { path, version: formatGitVersion(parsed), raw, source: 'setting' }
  }

  return {
    override: () => override,
    info,
    async set(path, signal) {
      if (path === null) {
        override = null
        probe = undefined
        return await info(signal)
      }
      const adopted = await validate(path, signal)
      override = path
      probe = Promise.resolve(adopted)
      return adopted
    },
  }
}
