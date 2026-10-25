// /dsh-git 的 RPC 处理器（可行性调研 §6.3）。
// 三条铁律：
// 1. handler 永不 throw —— 任何失败都变成 { ok:false, error:{ code, message, details } }；
// 2. payload 是 unknown —— 只接受对象 + 字符串 sessionId，其余一律 git/invalid-payload；
// 3. cwd 永不来自客户端 —— sessionId 只在 Host 侧解析（见 repo-resolver）。

import type {
  ConnectionRpcFailure,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'

import type { BootstrapValue, LogValue, StatusValue, WritePolicyValue } from '../shared/protocol.ts'
import type { GitRunner } from './git-executor.ts'
import { GitCommandFailure, messageOf } from './git-executor.ts'
import type { LogQuery } from './git/log.ts'
import { readLog } from './git/log.ts'
import { readStatus } from './git/status.ts'
import type { SessionSources } from './repo-resolver.ts'
import { resolveRepository } from './repo-resolver.ts'

/** Longest accepted sessionId; keeps a pathological payload out of every git call. */
const MAX_SESSION_ID_LENGTH = 200

/**
 * Fail-closed placeholder used until the sandbox gate (M0 T4) is wired:
 * a missing gate must never enable writes.
 */
const UNAVAILABLE_WRITE_POLICY: WritePolicyValue = {
  mode: 'read-only',
  reason: '写能力门禁尚未接线（fail closed）；沙箱边界判定接入前不可写',
}

/** Everything the handler needs; all session services are lazy and optional. */
export interface RpcDeps extends SessionSources {
  runner: GitRunner
  /** Write-capability decision for one resolved repository (M0 T4). */
  writePolicy?:
    | ((input: { repoRoot: string; sessionId: string }) => WritePolicyValue | Promise<WritePolicyValue>)
    | undefined
  /** Monotonic repository version; M0 T5b binds it to the watch/cache layer. */
  version?: (() => number) | undefined
}

/** The RPC handler shape used by `ctx.connection.rpc.handle` (peer unused today). */
export type GitRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcHandlerResult>

/** Build the handler registered on {@link RPC_CHANNEL}. */
export function createRpcHandler(deps: RpcDeps): GitRpcHandler {
  return async (endpoint, payload, signal) => {
    try {
      switch (endpoint) {
        case 'bootstrap':
          return await handleBootstrap(deps, payload, signal)
        case 'status':
          return await handleStatus(deps, payload, signal)
        case 'log':
          return await handleLog(deps, payload, signal)
        default:
          throw invalidPayload('unknown RPC endpoint', { endpoint })
      }
    } catch (error) {
      return toFailure(error)
    }
  }
}

async function handleBootstrap(
  deps: RpcDeps,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const resolution = await resolveRepository(deps, sessionId, signal)

  if (resolution.kind === 'no-session') throw noSession(sessionId)
  if (resolution.kind === 'not-a-repository') {
    return ok<BootstrapValue>({
      sessionId,
      repoRoot: null,
      status: null,
      log: null,
      writePolicy: {
        mode: 'read-only',
        reason: '当前会话目录不在 Git 仓库中',
      },
      version: currentVersion(deps),
    })
  }

  const status = await readStatus(deps.runner, resolution.root, { signal })
  const log = await readLog(deps.runner, resolution.root, {}, { signal })
  const writePolicy = await resolveWritePolicy(deps, resolution.root, sessionId)
  return ok<BootstrapValue>({
    sessionId,
    repoRoot: resolution.root,
    status,
    log,
    writePolicy,
    version: currentVersion(deps),
  })
}

async function handleStatus(
  deps: RpcDeps,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const status = await readStatus(deps.runner, root, { signal })
  return ok<StatusValue>(status)
}

async function handleLog(
  deps: RpcDeps,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const query = parseLogQuery(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const page = await readLog(deps.runner, root, query, { signal })
  return ok<LogValue>(page)
}

/** Resolve the repository root or throw the structured empty-state error. */
async function repositoryRoot(
  deps: RpcDeps,
  sessionId: string,
  signal: AbortSignal,
): Promise<string> {
  const resolution = await resolveRepository(deps, sessionId, signal)
  if (resolution.kind === 'no-session') throw noSession(sessionId)
  if (resolution.kind === 'not-a-repository') {
    throw new GitCommandFailure('git/not-a-repository', resolution.reason, {
      cwd: resolution.cwd,
    })
  }
  return resolution.root
}

async function resolveWritePolicy(
  deps: RpcDeps,
  repoRoot: string,
  sessionId: string,
): Promise<WritePolicyValue> {
  if (deps.writePolicy === undefined) return { ...UNAVAILABLE_WRITE_POLICY }
  return await deps.writePolicy({ repoRoot, sessionId })
}

function currentVersion(deps: RpcDeps): number {
  return deps.version?.() ?? 0
}

function parseSessionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalidPayload('payload must be an object', {})
  }
  const sessionId: unknown = (payload as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== 'string') {
    throw invalidPayload('sessionId must be a string', {})
  }
  if (sessionId.trim() === '') {
    throw invalidPayload('sessionId must not be empty', {})
  }
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw invalidPayload('sessionId is too long', { length: sessionId.length })
  }
  return sessionId
}

function parseLogQuery(payload: unknown): LogQuery {
  const record = payload as { cursor?: unknown; limit?: unknown }
  const cursor = record.cursor
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw invalidPayload('log cursor must be a string', {})
  }
  const limit = record.limit
  if (limit !== undefined && typeof limit !== 'number') {
    throw invalidPayload('log limit must be a number', {})
  }
  return { cursor, limit }
}

function ok<T>(value: T): ConnectionRpcHandlerResult {
  return { ok: true, value }
}

function toFailure(error: unknown): ConnectionRpcHandlerResult {
  if (error instanceof GitCommandFailure) {
    const failure: ConnectionRpcFailure = {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
    }
    return { ok: false, error: failure }
  }
  return {
    ok: false,
    error: {
      code: 'git/exec-failed',
      message: messageOf(error),
      details: {},
    },
  }
}

function noSession(sessionId: string): GitCommandFailure {
  return new GitCommandFailure('git/no-session', 'session working directory is unknown', {
    sessionId,
  })
}

function invalidPayload(message: string, details: Record<string, unknown>): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}
