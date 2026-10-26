// React-free 的 RPC 封装：浏览器端调用 Host 的 /dsh-git 通道。
// 同源 POST + Cookie 鉴权（Host 侧走 connection.requestRejection）；传输错误与协议
// 形状错误都收敛成结构化的 GitError，调用方不需要 try/catch。
import { RPC_CHANNEL, isRpcResult } from '../shared/protocol.ts'
import type {
  AddToVcsRequest,
  AddToVcsValue,
  AmendMessageRequest,
  BootstrapValue,
  BranchesValue,
  CommitDetailValue,
  CommitFilesRequest,
  CommitRequest,
  CommitResultValue,
  ConsoleValue,
  DiffFileValue,
  DiffRequest,
  GitError,
  LogRequest,
  LogValue,
  PullForPushRequest,
  PullForPushValue,
  PushPreviewValue,
  PushRequest,
  PushValue,
  RefsValue,
  RollbackRequest,
  RollbackValue,
  RpcResult,
  StatusValue,
} from '../shared/protocol.ts'

export interface GitClient {
  bootstrap(sessionId: string, signal?: AbortSignal): Promise<RpcResult<BootstrapValue>>
  status(sessionId: string, signal?: AbortSignal): Promise<RpcResult<StatusValue>>
  log(request: LogRequest, signal?: AbortSignal): Promise<RpcResult<LogValue>>
  branches(sessionId: string, signal?: AbortSignal): Promise<RpcResult<BranchesValue>>
  refs(sessionId: string, signal?: AbortSignal): Promise<RpcResult<RefsValue>>
  commit(request: CommitRequest, signal?: AbortSignal): Promise<RpcResult<CommitDetailValue>>
  diff(request: DiffRequest, signal?: AbortSignal): Promise<RpcResult<DiffFileValue>>
  console(sessionId: string, signal?: AbortSignal): Promise<RpcResult<ConsoleValue>>
  // A2 写端点：调用方用 newRequestId() 为每次用户动作生成一次 requestId，重试时复用。
  commitFiles(request: CommitFilesRequest, signal?: AbortSignal): Promise<RpcResult<CommitResultValue>>
  amendMessage(request: AmendMessageRequest, signal?: AbortSignal): Promise<RpcResult<CommitResultValue>>
  rollback(request: RollbackRequest, signal?: AbortSignal): Promise<RpcResult<RollbackValue>>
  addToVcs(request: AddToVcsRequest, signal?: AbortSignal): Promise<RpcResult<AddToVcsValue>>
  pushPreview(sessionId: string, signal?: AbortSignal): Promise<RpcResult<PushPreviewValue>>
  push(request: PushRequest, signal?: AbortSignal): Promise<RpcResult<PushValue>>
  pullForPush(request: PullForPushRequest, signal?: AbortSignal): Promise<RpcResult<PullForPushValue>>
}

/** One id per user action (A2): the Host de-duplicates repeated submissions by it. */
export function newRequestId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function failure<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'git/exec-failed', message } satisfies GitError }
}

/** 页面是文档相对路径部署，通道用去掉前导 `/` 的形式。 */
function endpointUrl(endpoint: string): string {
  return `${RPC_CHANNEL.slice(1)}/${endpoint}`
}

async function call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>> {
  try {
    const response = await globalThis.fetch(endpointUrl(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return failure(`HTTP ${response.status}：${endpoint}`)
    const raw: unknown = await response.json()
    if (!isRpcResult<T>(raw)) return failure('Host 响应不符合 /dsh-git 协议')
    return raw
  } catch (error) {
    if (signal?.aborted === true) return failure('请求已取消')
    return failure(error instanceof Error ? error.message : String(error))
  }
}

export function createGitClient(_ctx: unknown): GitClient {
  return {
    bootstrap: (sessionId, signal) => call<BootstrapValue>('bootstrap', { sessionId }, signal),
    status: (sessionId, signal) => call<StatusValue>('status', { sessionId }, signal),
    log: (request, signal) => call<LogValue>('log', request, signal),
    branches: (sessionId, signal) => call<BranchesValue>('branches', { sessionId }, signal),
    refs: (sessionId, signal) => call<RefsValue>('refs', { sessionId }, signal),
    commit: (request, signal) => call<CommitDetailValue>('commit', request, signal),
    diff: (request, signal) => call<DiffFileValue>('diff', request, signal),
    console: (sessionId, signal) => call<ConsoleValue>('console', { sessionId }, signal),
    commitFiles: (request, signal) => call<CommitResultValue>('commitFiles', request, signal),
    amendMessage: (request, signal) => call<CommitResultValue>('amendMessage', request, signal),
    rollback: (request, signal) => call<RollbackValue>('rollback', request, signal),
    addToVcs: (request, signal) => call<AddToVcsValue>('addToVcs', request, signal),
    pushPreview: (sessionId, signal) => call<PushPreviewValue>('pushPreview', { sessionId }, signal),
    push: (request, signal) => call<PushValue>('push', request, signal),
    pullForPush: (request, signal) => call<PullForPushValue>('pullForPush', request, signal),
  }
}
