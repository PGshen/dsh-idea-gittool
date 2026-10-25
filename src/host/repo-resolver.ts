// sessionId → cwd → 仓库根（可行性调研 §7）：
// 客户端只传 sessionId；cwd 从 live 会话头 / workingDirectory 投影 / 持久化 header 解析，
// 全部缺失时兜底 sandboxPolicy.workspaceRoot。解析结果先 stat 确认是目录，
// 再用 `git rev-parse --show-toplevel` 得到仓库根；以后的命令一律显式 cwd: root。

import { stat } from 'node:fs/promises'

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

import type { GitRunner } from './git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from './git-executor.ts'

/** Structural subset of `ctx.sessions`. */
export interface SessionsLike {
  get(id: SessionId): Session | undefined
}

/** Structural subset of `ctx.workingDirectory` (projection read, no I/O). */
export interface WorkingDirectoryLike {
  get(session: Session): string
}

/** Structural subset of a persistence snapshot: only the immutable header cwd is used. */
export interface SessionPersistenceSnapshotLike {
  header: { cwd?: string | undefined }
}

/** Structural subset of `ctx.sessionPersistence`. */
export interface SessionPersistenceLike {
  stat(
    id: SessionId,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<SessionPersistenceSnapshotLike | undefined>
}

/** Structural subset of `ctx.sandboxPolicy` used for the deployment fallback. */
export interface SandboxPolicyLike {
  workspaceRoot: string
}

/**
 * Lazy service sources. They are getters because a composition may load these
 * services after this plugin is applied; an absent service is not an error.
 */
export interface SessionSources {
  sessions?: (() => SessionsLike | undefined) | undefined
  workingDirectory?: (() => WorkingDirectoryLike | undefined) | undefined
  sessionPersistence?: (() => SessionPersistenceLike | undefined) | undefined
  sandboxPolicy?: (() => SandboxPolicyLike | undefined) | undefined
}

/** Everything the resolver needs: git execution plus optional session services. */
export interface RepoResolverDeps extends SessionSources {
  runner: GitRunner
}

/** Per-resolution execution options. */
export interface ResolveRepositoryOptions {
  timeoutMs?: number | undefined
}

/** Resolution outcome: a repository, a known-but-not-a-repository directory, or no cwd at all. */
export type RepoResolution =
  | { kind: 'repository'; cwd: string; root: string }
  | { kind: 'not-a-repository'; cwd: string; reason: string }
  | { kind: 'no-session' }

/** The session's effective directory, or undefined when nothing knows one. */
export async function resolveSessionCwd(
  deps: SessionSources,
  sessionId: string,
  signal?: AbortSignal | undefined,
): Promise<string | undefined> {
  const id = sessionId as SessionId

  const live = deps.sessions?.()?.get(id)
  if (live !== undefined) {
    const effective = deps.workingDirectory?.()?.get(live)
    if (effective !== undefined && effective !== '') return effective
    const headerCwd = live.header.cwd
    if (headerCwd !== undefined && headerCwd !== '') return headerCwd
    return sandboxWorkspaceRoot(deps)
  }

  const persistence = deps.sessionPersistence?.()
  if (persistence !== undefined) {
    try {
      const stored = await persistence.stat(
        id,
        signal === undefined ? undefined : { signal },
      )
      const storedCwd = stored?.header.cwd
      if (storedCwd !== undefined && storedCwd !== '') return storedCwd
      // 持久化服务存在、但没有这个会话的记录：客户端传了一个无效 sessionId，
      // 必须按 no-session 处理，不能退化到部署级 workspaceRoot（那会把宿主机
      // 的 cwd 当成本会话的仓库）。
      return undefined
    } catch (error) {
      // A dead storage backend must not disable the deployment fallback.
      if (signal?.aborted === true) throw error
    }
  }
  return sandboxWorkspaceRoot(deps)
}

/** Resolve the session's repository root through git, never trusting a client-supplied cwd. */
export async function resolveRepository(
  deps: RepoResolverDeps,
  sessionId: string,
  signal?: AbortSignal | undefined,
  options: ResolveRepositoryOptions = {},
): Promise<RepoResolution> {
  const cwd = await resolveSessionCwd(deps, sessionId, signal)
  if (cwd === undefined) return { kind: 'no-session' }
  if (!(await isDirectory(cwd))) {
    return { kind: 'not-a-repository', cwd, reason: 'session directory does not exist' }
  }

  let result
  try {
    result = await deps.runner([...GIT_BASE_ARGV, 'rev-parse', '--show-toplevel'], {
      cwd,
      signal,
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    // A deadline or an oversized stream is not evidence of "not a repository".
    if (error instanceof GitCommandFailure) {
      if (error.code === 'git/timeout' || error.code === 'git/output-too-large') throw error
      if (error.code === 'git/not-a-repository') {
        return { kind: 'not-a-repository', cwd, reason: error.message }
      }
    }
    throw error
  }

  if (result.exitCode !== 0) {
    return {
      kind: 'not-a-repository',
      cwd,
      reason: firstLine(result.stderr) ?? 'git rev-parse --show-toplevel failed',
    }
  }
  const root = firstLine(result.stdout)
  if (root === undefined) {
    return { kind: 'not-a-repository', cwd, reason: 'git reported no working tree' }
  }
  return { kind: 'repository', cwd, root }
}

function sandboxWorkspaceRoot(deps: SessionSources): string | undefined {
  const workspaceRoot = deps.sandboxPolicy?.()?.workspaceRoot
  if (workspaceRoot === undefined || workspaceRoot === '') return undefined
  return workspaceRoot
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value !== '')
  return line
}
