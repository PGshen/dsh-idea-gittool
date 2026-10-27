// React-free 的 RPC 封装：浏览器端调用 Host 的 /dsh-git 通道。
// 同源 POST + Cookie 鉴权（Host 侧走 connection.requestRejection）；传输错误与协议
// 形状错误都收敛成结构化的 GitError，调用方不需要 try/catch。
import { RPC_CHANNEL, isRpcResult } from '../shared/protocol.ts'
import type {
  BlameRequest,
  BlameValue,
  CompareRequest,
  CompareValue,
  FileHistoryRequest,
  FileHistoryValue,
  AddToVcsRequest,
  AddToVcsValue,
  AmendMessageRequest,
  BootstrapValue,
  BranchesValue,
  CommitDetailValue,
  CommitFilesRequest,
  CommitRequest,
  CommitResultValue,
  ConflictCommandValue,
  ConsoleValue,
  DiffFileValue,
  DiffRequest,
  GitError,
  LogRequest,
  LogValue,
  MergeFileRequest,
  MergeFileValue,
  OperationStateValue,
  PullForPushRequest,
  PullForPushValue,
  PushPreviewValue,
  PushRequest,
  PushValue,
  RefsValue,
  ResetPreviewRequest,
  ResetPreviewValue,
  RollbackRequest,
  RollbackValue,
  RpcEndpointTypes,
  RpcResult,
  StashFilesRequest,
  StashFilesValue,
  StashListValue,
  StatusValue,
  WriteEndpoint,
} from '../shared/protocol.ts'

/** Typed call for one write endpoint (request and value from {@link RpcEndpointTypes}). */
export type WriteMethod<K extends WriteEndpoint> = (
  request: RpcEndpointTypes[K]['request'],
  signal?: AbortSignal,
) => Promise<RpcResult<RpcEndpointTypes[K]['value']>>

/** Every write endpoint as a method (A2 + A3); the action store dispatches through this map. */
export type WriteMethods = { [K in WriteEndpoint]: WriteMethod<K> }

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
  // A3 read endpoints.
  operationState(sessionId: string, signal?: AbortSignal): Promise<RpcResult<OperationStateValue>>
  conflictCommand(sessionId: string, signal?: AbortSignal): Promise<RpcResult<ConflictCommandValue>>
  resetPreview(request: ResetPreviewRequest, signal?: AbortSignal): Promise<RpcResult<ResetPreviewValue>>
  stashList(sessionId: string, signal?: AbortSignal): Promise<RpcResult<StashListValue>>
  stashFiles(request: StashFilesRequest, signal?: AbortSignal): Promise<RpcResult<StashFilesValue>>
  // A3 write endpoints: UI code calls them through the action store (`actions.run`).
  operationControl: WriteMethod<'operationControl'>
  operationCommit: WriteMethod<'operationCommit'>
  resolveConflict: WriteMethod<'resolveConflict'>
  checkout: WriteMethod<'checkout'>
  createBranch: WriteMethod<'createBranch'>
  renameBranch: WriteMethod<'renameBranch'>
  deleteBranch: WriteMethod<'deleteBranch'>
  merge: WriteMethod<'merge'>
  rebase: WriteMethod<'rebase'>
  cherryPick: WriteMethod<'cherryPick'>
  revertCommit: WriteMethod<'revertCommit'>
  reset: WriteMethod<'reset'>
  fetch: WriteMethod<'fetch'>
  pull: WriteMethod<'pull'>
  updateProject: WriteMethod<'updateProject'>
  resetToRemote: WriteMethod<'resetToRemote'>
  stashCreate: WriteMethod<'stashCreate'>
  stashApply: WriteMethod<'stashApply'>
  stashDrop: WriteMethod<'stashDrop'>
  // B1 three-way merge: the read feeds the merge window; writes go through the action store.
  mergeFile(request: MergeFileRequest, signal?: AbortSignal): Promise<RpcResult<MergeFileValue>>
  // B2 读端点（T1 冻结类型；Host 在 T2/T3 登记实现）。
  blame(request: BlameRequest, signal?: AbortSignal): Promise<RpcResult<BlameValue>>
  fileHistory(request: FileHistoryRequest, signal?: AbortSignal): Promise<RpcResult<FileHistoryValue>>
  compare(request: CompareRequest, signal?: AbortSignal): Promise<RpcResult<CompareValue>>
  mergeDraftSave: WriteMethod<'mergeDraftSave'>
  mergeApply: WriteMethod<'mergeApply'>
  unresolveConflict: WriteMethod<'unresolveConflict'>
}

/** Compile-time check: GitClient covers every write endpoint with the protocol's types. */
export const GIT_CLIENT_COVERS_WRITES: GitClient extends WriteMethods ? true : false = true

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

/**
 * A non-2xx reply may still carry the protocol's error envelope (e.g. 413 body-too-large);
 * surface that structured error instead of a bare "HTTP <status>". Never reads success from it.
 */
async function errorBodyOf<T>(response: Response): Promise<RpcResult<T> | undefined> {
  try {
    const raw: unknown = await response.json()
    return isRpcResult<T>(raw) && !raw.ok ? raw : undefined
  } catch {
    return undefined
  }
}

async function call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>> {
  try {
    const response = await globalThis.fetch(endpointUrl(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    })
    // Transport failures read like Host errors (English, technical); the UI titles them by code.
    if (!response.ok) return (await errorBodyOf<T>(response)) ?? failure(`HTTP ${response.status}: ${endpoint}`)
    const raw: unknown = await response.json()
    if (!isRpcResult<T>(raw)) return failure('Host response does not match the /dsh-git protocol')
    return raw
  } catch (error) {
    if (signal?.aborted === true) return failure('Request cancelled')
    return failure(error instanceof Error ? error.message : String(error))
  }
}

/** Method for one write endpoint: posts the request as-is. */
function write<K extends WriteEndpoint>(endpoint: K): WriteMethod<K> {
  return (request, signal) => call<RpcEndpointTypes[K]['value']>(endpoint, request, signal)
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
    operationState: (sessionId, signal) => call<OperationStateValue>('operationState', { sessionId }, signal),
    conflictCommand: (sessionId, signal) => call<ConflictCommandValue>('conflictCommand', { sessionId }, signal),
    resetPreview: (request, signal) => call<ResetPreviewValue>('resetPreview', request, signal),
    stashList: (sessionId, signal) => call<StashListValue>('stashList', { sessionId }, signal),
    stashFiles: (request, signal) => call<StashFilesValue>('stashFiles', request, signal),
    operationControl: write('operationControl'),
    operationCommit: write('operationCommit'),
    resolveConflict: write('resolveConflict'),
    checkout: write('checkout'),
    createBranch: write('createBranch'),
    renameBranch: write('renameBranch'),
    deleteBranch: write('deleteBranch'),
    merge: write('merge'),
    rebase: write('rebase'),
    cherryPick: write('cherryPick'),
    revertCommit: write('revertCommit'),
    reset: write('reset'),
    fetch: write('fetch'),
    pull: write('pull'),
    updateProject: write('updateProject'),
    resetToRemote: write('resetToRemote'),
    stashCreate: write('stashCreate'),
    stashApply: write('stashApply'),
    stashDrop: write('stashDrop'),
    mergeFile: (request, signal) => call<MergeFileValue>('mergeFile', request, signal),
    blame: (request, signal) => call<BlameValue>('blame', request, signal),
    fileHistory: (request, signal) => call<FileHistoryValue>('fileHistory', request, signal),
    compare: (request, signal) => call<CompareValue>('compare', request, signal),
    mergeDraftSave: write('mergeDraftSave'),
    mergeApply: write('mergeApply'),
    unresolveConflict: write('unresolveConflict'),
  }
}
