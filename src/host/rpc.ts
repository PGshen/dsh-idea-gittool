// /dsh-git 的 RPC 处理器（可行性调研 §6.3、§9）。
// 三条铁律：
// 1. handler 永不 throw —— 任何失败都变成 { ok:false, error:{ code, message, details } }；
// 2. payload 是 unknown —— 只接受对象 + 字符串 sessionId，其余一律 git/invalid-payload；
// 3. cwd 永不来自客户端 —— sessionId 只在 Host 侧解析（见 repo-resolver）。
//
// T5b 起每个仓库根都有缓存与 watch：版本号单调递增，watch 信号到达即 bump 版本，
// 旧条目因 version 不匹配自动失效；响应带读取时的 version，客户端据此丢弃过期响应。

import type {
  ConnectionRpcFailure,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'

import type {
  BootstrapValue,
  BranchesValue,
  CommitDetailValue,
  ConflictCommandValue,
  ConsoleValue,
  DiffFileValue,
  LogValue,
  OperationStateValue,
  PushPreviewValue,
  RefsValue,
  RpcEndpointTypes,
  StatusValue,
  WriteEndpoint,
  WritePolicyValue,
} from '../shared/protocol.ts'
import { isWriteEndpoint } from '../shared/protocol.ts'
import type { GitConsole } from './console.ts'
import type { RepoCache } from './cache.ts'
import { createRepoCache } from './cache.ts'
import type { FsWatch, RepoWatch } from './watch.ts'
import { watchRepo } from './watch.ts'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import type { GitRunner, WriteOperation } from './git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, bindWriteContext, messageOf, notImplemented } from './git-executor.ts'
import {
  checkoutOperation,
  createBranchOperation,
  deleteBranchOperation,
  renameBranchOperation,
} from './git/branch-write.ts'
import { conflictCommandFor, resolveConflictOperation } from './git/conflict.ts'
import { addToVcsOperation, amendMessageOperation, commitFilesOperation } from './git/commit-write.ts'
import { operationCommitOperation, operationControlOperation, readOperationState } from './git/operation.ts'
import { pullForPushOperation } from './git/pull.ts'
import { pushOperation, readPushPreview } from './git/push.ts'
import { rollbackOperation } from './git/rollback.ts'
import type { WriteQueue } from './write-queue.ts'
import { createWriteQueue } from './write-queue.ts'
import { readBranches } from './git/branches.ts'
import { readCommit } from './git/commit.ts'
import type { DiffQuery } from './git/diff.ts'
import { readDiff, validateRepoPath } from './git/diff.ts'
import type { LogQuery } from './git/log.ts'
import { logFilterSignature, normalizeLogFilters, readLog } from './git/log.ts'
import { readRefs } from './git/refs.ts'
import { readStatus } from './git/status.ts'
import type { SandboxGateDeps, SandboxLike, SandboxPolicySource, WriteAccess } from './sandbox-gate.ts'
import { assertWritable, evaluateWritePolicy, resolveWriteAccess } from './sandbox-gate.ts'
import type { SessionSources } from './repo-resolver.ts'
import { resolveRepository } from './repo-resolver.ts'

/** Longest accepted sessionId; keeps a pathological payload out of every git call. */
const MAX_SESSION_ID_LENGTH = 200

const STATUS_CACHE_KEY = 'status'
const LOG_CACHE_PREFIX = 'log'
const BRANCHES_CACHE_KEY = 'branches'
const REFS_CACHE_KEY = 'refs'
const COMMIT_CACHE_PREFIX = 'commit'
const DIFF_CACHE_PREFIX = 'diff'
const PUSH_PREVIEW_CACHE_KEY = 'pushPreview'
const OPERATION_STATE_CACHE_KEY = 'operationState'
/** Longest accepted requestId (client-generated UUIDs are 36). */
const MAX_REQUEST_ID_LENGTH = 100

/** A write endpoint's response without the version the RPC layer stamps on it. */
export type WriteValue<E extends WriteEndpoint> = Omit<RpcEndpointTypes[E]['value'], 'version'>

/** Write endpoints (A2 + A3) → their operations; tests override single entries. */
export type WriteOperations = { [E in WriteEndpoint]: WriteOperation<unknown, WriteValue<E>> }

/**
 * Placeholder for an A3 write endpoint registered in T1 ahead of its implementation:
 * refuses at parse time (before the queue and gate), so nothing runs.
 */
function pendingOperation<E extends WriteEndpoint>(endpoint: E): WriteOperation<unknown, WriteValue<E>> {
  return {
    parse() {
      throw notImplemented(endpoint)
    },
    run() {
      return Promise.reject(notImplemented(endpoint))
    },
  }
}

const DEFAULT_WRITE_OPERATIONS: WriteOperations = {
  commitFiles: commitFilesOperation,
  amendMessage: amendMessageOperation,
  rollback: rollbackOperation,
  addToVcs: addToVcsOperation,
  push: pushOperation,
  pullForPush: pullForPushOperation,
  operationControl: operationControlOperation,
  operationCommit: operationCommitOperation,
  // A3: replaced by T4 (integrate/update), T5 (stash).
  resolveConflict: resolveConflictOperation,
  checkout: checkoutOperation,
  createBranch: createBranchOperation,
  renameBranch: renameBranchOperation,
  deleteBranch: deleteBranchOperation,
  merge: pendingOperation('merge'),
  rebase: pendingOperation('rebase'),
  cherryPick: pendingOperation('cherryPick'),
  revertCommit: pendingOperation('revertCommit'),
  reset: pendingOperation('reset'),
  fetch: pendingOperation('fetch'),
  pull: pendingOperation('pull'),
  updateProject: pendingOperation('updateProject'),
  resetToRemote: pendingOperation('resetToRemote'),
  stashCreate: pendingOperation('stashCreate'),
  stashApply: pendingOperation('stashApply'),
  stashDrop: pendingOperation('stashDrop'),
}

/** Everything the handler needs; all session services are lazy and optional. */
export interface RpcDeps extends SessionSources {
  runner: GitRunner
  /** Sandbox policy source; the write gate fails closed without it (M0 T4). */
  sandboxPolicy?: (() => SandboxPolicySource | undefined) | undefined
  /** Confinement provider used for the write-gate probe (M0 T4). */
  sandbox?: (() => SandboxLike | undefined) | undefined
  /** Test seam: an explicit gate overrides {@link evaluateWritePolicy}. */
  writePolicy?:
    | ((input: { repoRoot: string; sessionId: string }) => WritePolicyValue | Promise<WritePolicyValue>)
    | undefined
  /** Per-repository refresh state; the runtime creates one when omitted (M0 T5b). */
  cache?: (() => RepoCache | undefined) | undefined
  /** watch implementation factory (`ctx.fs.watch` adapter); absent → polling fallback. */
  fsWatch?: (() => FsWatch | undefined) | undefined
  /** Debounce override for tests; watch.ts's default is 250ms. */
  watchDebounceMs?: number | undefined
  /** Injectable clock for cache/watch timestamps. */
  now?: (() => number) | undefined
  /** Git console buffer fed by the instrumented runner; absent → empty console (A1). */
  console?: GitConsole | undefined
  /** Test seam: replaces individual write operations (A2). */
  writeOperations?: Partial<WriteOperations> | undefined
}

/** The RPC handler shape used by `ctx.connection.rpc.handle` (peer unused today). */
export type GitRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcHandlerResult>

/** A handler bound to its per-repository cache and watches. */
export interface RpcRuntime {
  handler: GitRpcHandler
  /** Stop every watch; idempotent, never rejects. */
  dispose: () => Promise<void>
}

interface HandlerRuntime {
  cache: () => RepoCache
  ensureWatch: (repoRoot: string) => RepoWatch | undefined
  /** Git version, probed once per runtime; undefined when the probe failed. */
  gitVersion: (cwd: string, signal: AbortSignal) => Promise<string | undefined>
  /** Per-repository serial write queue with requestId de-duplication (A2). */
  writes: WriteQueue
  operations: WriteOperations
  /**
   * Writes run on the runtime's lifetime, not the HTTP request's (评审 I1, ADR 0007): a closed
   * tab or dropped connection must not kill a commit half-way or skip its index cleanup.
   * Each command still has its own write/network deadline.
   */
  writeSignal: AbortSignal
  /** Where the repository's git data lives, memoized per repository root (评审 I6). */
  gitDirs: (repoRoot: string, signal: AbortSignal) => Promise<string[] | undefined>
}

/** `git version 2.50.1 (Apple Git-155)` → `2.50.1`. */
export function parseGitVersion(stdout: string): string | undefined {
  return /git version (\d+(?:\.\d+)+)/.exec(stdout)?.[1]
}

/** Build the handler registered on {@link RPC_CHANNEL}; the runtime stays undisposed. */
export function createRpcHandler(deps: RpcDeps): GitRpcHandler {
  return createRpcRuntime(deps).handler
}

/** Build the handler together with its lifecycle owner (index.ts disposes it on unload). */
export function createRpcRuntime(deps: RpcDeps): RpcRuntime {
  // Web 组合当前没有挂载 `fs` 服务，watch 会降级（version 恒定 0）。此时若缓存无 TTL，
  // 状态会永久陈旧；给兜底缓存 1s TTL：3s 轮询仍拿到新数据，短时间突发请求仍可复用。
  // 接入 watch 的部署会用无 TTL 的 deps.cache（version 变化即失效）。
  const fallbackCache = createRepoCache(deps.now === undefined ? { ttlMs: 1_000 } : { now: deps.now, ttlMs: 1_000 })
  const cacheOf = (): RepoCache => deps.cache?.() ?? fallbackCache
  const watches = new Map<string, RepoWatch>()
  let disposed = false

  const ensureWatch = (repoRoot: string): RepoWatch | undefined => {
    if (disposed) return undefined
    const existing = watches.get(repoRoot)
    if (existing !== undefined) return existing
    try {
      const fsWatch = deps.fsWatch?.()
      const watch = watchRepo({
        root: repoRoot,
        // A change signal invalidates every cached value for that repository.
        onChange: () => {
          cacheOf().bumpVersion(repoRoot)
        },
        ...(fsWatch === undefined ? {} : { fsWatch }),
        ...(deps.watchDebounceMs === undefined ? {} : { debounceMs: deps.watchDebounceMs }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      })
      watches.set(repoRoot, watch)
      return watch
    } catch {
      // Watch is an optimization; a broken provider must never break reads.
      return undefined
    }
  }

  // Only a successful probe is memoized; a failed one is retried on the next bootstrap.
  let gitVersionProbe: Promise<string | undefined> | undefined
  const gitVersion = async (cwd: string, signal: AbortSignal): Promise<string | undefined> => {
    gitVersionProbe ??= deps.runner(['--version'], { cwd, signal })
      .then(result => (result.exitCode === 0 ? parseGitVersion(result.stdout) : undefined))
      .catch(() => undefined)
    const version = await gitVersionProbe
    if (version === undefined) gitVersionProbe = undefined
    return version
  }

  const lifetime = new AbortController()
  const gitDirsByRoot = new Map<string, string[]>()
  const gitDirs = async (repoRoot: string, signal: AbortSignal): Promise<string[] | undefined> => {
    const known = gitDirsByRoot.get(repoRoot)
    if (known !== undefined) return known
    try {
      const result = await deps.runner(
        [...GIT_BASE_ARGV, 'rev-parse', '--absolute-git-dir', '--git-common-dir'],
        { cwd: repoRoot, signal },
      )
      if (result.exitCode !== 0) return undefined
      const dirs = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((dir) => (isAbsolute(dir) ? dir : resolvePath(repoRoot, dir)))
      gitDirsByRoot.set(repoRoot, dirs)
      return dirs
    } catch {
      // Unknown location: the root check still applies and the sandbox still enforces writes.
      return undefined
    }
  }

  const runtime: HandlerRuntime = {
    writeSignal: lifetime.signal,
    gitDirs,
    cache: cacheOf,
    ensureWatch,
    gitVersion,
    writes: createWriteQueue(),
    operations: { ...DEFAULT_WRITE_OPERATIONS, ...deps.writeOperations },
  }

  const handler: GitRpcHandler = async (endpoint, payload, signal) => {
    try {
      switch (endpoint) {
        case 'bootstrap':
          return await handleBootstrap(deps, runtime, payload, signal)
        case 'status':
          return await handleStatus(deps, runtime, payload, signal)
        case 'log':
          return await handleLog(deps, runtime, payload, signal)
        case 'branches':
          return await handleCached<BranchesValue>(deps, runtime, payload, signal, BRANCHES_CACHE_KEY, (root) =>
            readBranches(deps.runner, root, { signal }),
          )
        case 'refs':
          return await handleCached<RefsValue>(deps, runtime, payload, signal, REFS_CACHE_KEY, (root) =>
            readRefs(deps.runner, root, { signal }),
          )
        case 'commit': {
          const sha = parseCommitSha(payload)
          return await handleCached<CommitDetailValue>(
            deps,
            runtime,
            payload,
            signal,
            `${COMMIT_CACHE_PREFIX}:${sha}`,
            (root) => readCommit(deps.runner, root, sha, { signal }),
          )
        }
        case 'diff': {
          const query = parseDiffQuery(payload)
          return await handleCached<DiffFileValue>(
            deps,
            runtime,
            payload,
            signal,
            `${DIFF_CACHE_PREFIX}:${JSON.stringify([query.scope, query.sha ?? '', query.parent ?? '', query.path])}`,
            (root) => readDiff(deps.runner, root, query, { signal }),
          )
        }
        case 'console':
          return await handleConsole(deps, payload, signal)
        case 'pushPreview':
          return await handleCached<PushPreviewValue>(deps, runtime, payload, signal, PUSH_PREVIEW_CACHE_KEY, (root) =>
            readPushPreview(deps.runner, root, { signal }),
          )
        case 'operationState':
          return await handleCached<OperationStateValue>(
            deps,
            runtime,
            payload,
            signal,
            OPERATION_STATE_CACHE_KEY,
            (root) => readOperationState(deps.runner, root, { signal }),
          )
        case 'conflictCommand': {
          const sessionId = parseSessionId(payload)
          return ok<ConflictCommandValue>(conflictCommandFor(await repositoryRoot(deps, sessionId, signal)))
        }
        // A3 read endpoints registered in T1; T4 (resetPreview) and T5 (stashList, stashFiles)
        // replace these cases.
        case 'resetPreview':
        case 'stashList':
        case 'stashFiles':
          parseSessionId(payload)
          throw notImplemented(endpoint)
        default:
          if (isWriteEndpoint(endpoint)) {
            return await handleWrite<object>(deps, runtime, payload, signal, runtime.operations[endpoint])
          }
          throw invalidPayload('unknown RPC endpoint', { endpoint })
      }
    } catch (error) {
      return toFailure(error)
    }
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    lifetime.abort()
    const closing = [...watches.values()].map(async (watch) => {
      await watch.close()
    })
    watches.clear()
    await Promise.allSettled(closing)
  }

  return { handler, dispose }
}

async function handleBootstrap(
  deps: RpcDeps,
  runtime: HandlerRuntime,
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
      writePolicy: {
        mode: 'read-only',
        reason: '当前会话目录不在 Git 仓库中',
        reasonCode: 'not-a-repository',
      },
      version: 0,
    })
  }

  // One version for the whole snapshot: a reader that races a watch bump keeps
  // the older version, so the client treats that data as stale and polls again.
  const version = runtime.cache().versionOf(resolution.root)
  const status = await cachedStatus(deps, runtime, resolution.root, signal, version)
  const writePolicy = await resolveWritePolicy(deps, runtime, resolution.root, sessionId, signal)
  const gitVersion = await runtime.gitVersion(resolution.root, signal)
  const pendingWrites = runtime.writes.pending(resolution.root)
  return ok<BootstrapValue>({
    sessionId,
    repoRoot: resolution.root,
    status,
    writePolicy,
    version,
    ...(gitVersion === undefined ? {} : { gitVersion }),
    ...(pendingWrites > 0 ? { pendingWrites } : {}),
  })
}

/**
 * Generic write endpoint (A2 T1):
 * payload validation → repository → per-repo queue (requestId de-dup) → fresh gate
 * evaluation → operation under the session's confinement → version bump.
 * The gate runs inside the queue so a write never executes on a stale decision,
 * and the version is bumped on failure too: a failed write may still have touched state.
 */
async function handleWrite<V extends object>(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  payload: unknown,
  signal: AbortSignal,
  operation: WriteOperation<unknown, V>,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const requestId = parseRequestId(payload)
  const input = operation.parse(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const writeSignal = runtime.writeSignal
  const value = await runtime.writes.run(root, requestId, async () => {
    const access = await resolveWriteAccessFor(deps, runtime, root, sessionId, writeSignal)
    assertWritable(access.policy)
    if (access.confiner === undefined) {
      throw new GitCommandFailure('git/sandbox-denied', 'write confinement is unavailable (fail closed)', {})
    }
    try {
      const result = await operation.run(bindWriteContext(deps.runner, root, access.confiner, writeSignal), input)
      return { ...result, version: runtime.cache().bumpVersion(root) }
    } catch (error) {
      runtime.cache().bumpVersion(root)
      throw error
    }
  })
  return ok(value)
}

async function handleStatus(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const version = runtime.cache().versionOf(root)
  const status = await cachedStatus(deps, runtime, root, signal, version)
  return ok<StatusValue>(status)
}

async function handleLog(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const query = parseLogQuery(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const version = runtime.cache().versionOf(root)
  const page = await cachedLog(deps, runtime, root, query, signal, version)
  return ok<LogValue>(page)
}

/**
 * Generic read endpoint: resolve the repository, serve from the version-keyed cache,
 * otherwise read and stamp the value with the version it was read at.
 */
async function handleCached<T extends object>(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  payload: unknown,
  signal: AbortSignal,
  key: string,
  read: (repoRoot: string) => Promise<T>,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  const root = await repositoryRoot(deps, sessionId, signal)
  const cache = runtime.cache()
  const version = cache.versionOf(root)
  const cached = cache.get<T>(root, key)
  if (cached !== undefined) return ok<T>(cached)

  runtime.ensureWatch(root)
  const value = { ...(await read(root)), version }
  cache.set(root, key, value, version)
  return ok<T>(value)
}

/** The console is process-wide and never cached: it is the record of the calls themselves. */
/** Console records of the session's repository only: the buffer is shared process-wide (评审 I5). */
async function handleConsole(
  deps: RpcDeps,
  payload: unknown,
  signal: AbortSignal,
): Promise<ConnectionRpcHandlerResult> {
  const sessionId = parseSessionId(payload)
  if (deps.console === undefined) return ok<ConsoleValue>({ records: [], truncated: false })
  const root = await repositoryRoot(deps, sessionId, signal)
  return ok<ConsoleValue>(deps.console.recent({ root }))
}

/** Cache-first status read; the cached value carries the version it was read at. */
async function cachedStatus(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  repoRoot: string,
  signal: AbortSignal,
  version: number,
): Promise<StatusValue> {
  const cache = runtime.cache()
  const cached = cache.get<StatusValue>(repoRoot, STATUS_CACHE_KEY)
  if (cached !== undefined) return cached

  runtime.ensureWatch(repoRoot)
  const status = await readStatus(deps.runner, repoRoot, { signal })
  const value: StatusValue = { ...status, version }
  // Rejected when a watch bump raced the read: the next request recomputes.
  cache.set(repoRoot, STATUS_CACHE_KEY, value, version)
  return value
}

/** Cache-first log page keyed by the cursor it continues from. */
async function cachedLog(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  repoRoot: string,
  query: LogQuery,
  signal: AbortSignal,
  version: number,
): Promise<LogValue> {
  const cache = runtime.cache()
  const filters = normalizeLogFilters(query as Record<string, unknown>)
  const key = `${LOG_CACHE_PREFIX}:${query.cursor ?? ''}:${query.limit === undefined ? '' : String(query.limit)}:${logFilterSignature(filters)}`
  const cached = cache.get<LogValue>(repoRoot, key)
  if (cached !== undefined) return cached

  runtime.ensureWatch(repoRoot)
  const page = await readLog(deps.runner, repoRoot, query, { signal })
  const value: LogValue = { ...page, version }
  cache.set(repoRoot, key, value, version)
  return value
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
  runtime: HandlerRuntime,
  repoRoot: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<WritePolicyValue> {
  if (deps.writePolicy !== undefined) return await deps.writePolicy({ repoRoot, sessionId })
  const gateDeps: SandboxGateDeps = {
    sessions: deps.sessions,
    sandboxPolicy: deps.sandboxPolicy,
    sandbox: deps.sandbox,
  }
  const gitDirs = await runtime.gitDirs(repoRoot, signal)
  return await evaluateWritePolicy({ repoRoot, sessionId, gitDirs }, gateDeps, { signal })
}

/** Gate decision for a write; the `writePolicy` test seam yields no confiner (writes refused). */
async function resolveWriteAccessFor(
  deps: RpcDeps,
  runtime: HandlerRuntime,
  repoRoot: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<WriteAccess> {
  if (deps.writePolicy !== undefined) return { policy: await deps.writePolicy({ repoRoot, sessionId }) }
  const gateDeps: SandboxGateDeps = {
    sessions: deps.sessions,
    sandboxPolicy: deps.sandboxPolicy,
    sandbox: deps.sandbox,
  }
  const gitDirs = await runtime.gitDirs(repoRoot, signal)
  return await resolveWriteAccess({ repoRoot, sessionId, gitDirs }, gateDeps, { signal })
}

function parseRequestId(payload: unknown): string {
  const requestId: unknown = (payload as { requestId?: unknown }).requestId
  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw invalidPayload('requestId must be a non-empty string', {})
  }
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw invalidPayload('requestId is too long', { length: requestId.length })
  }
  return requestId
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
  const record = payload as Record<string, unknown>
  const cursor = record.cursor
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw invalidPayload('log cursor must be a string', {})
  }
  const limit = record.limit
  if (limit !== undefined && typeof limit !== 'number') {
    throw invalidPayload('log limit must be a number', {})
  }
  // Type-checks every filter field; the normalized form also feeds the cache key.
  return { cursor, limit, ...normalizeLogFilters(record) }
}

function parseCommitSha(payload: unknown): string {
  parseSessionId(payload)
  const sha: unknown = (payload as { sha?: unknown }).sha
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw invalidPayload('sha must be 4-64 hexadecimal characters', {})
  }
  return sha.toLowerCase()
}

function parseDiffQuery(payload: unknown): DiffQuery & { path: string } {
  parseSessionId(payload)
  const record = payload as Record<string, unknown>
  const path = validateRepoPath(record.path)
  for (const key of ['scope', 'sha', 'parent'] as const) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'string') {
      throw invalidPayload(`diff ${key} must be a string`, {})
    }
  }
  const query: DiffQuery & { path: string } = { path, scope: record.scope }
  if (record.sha !== undefined) query.sha = record.sha
  if (record.parent !== undefined) query.parent = record.parent
  return query
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
