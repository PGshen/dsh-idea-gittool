// React-free 的 RPC 封装：浏览器端调用 Host 的 /dsh-git 通道。
// 同源 POST + Cookie 鉴权（Host 侧走 connection.requestRejection）；传输错误与协议
// 形状错误都收敛成结构化的 GitError，调用方不需要 try/catch。
import { RPC_CHANNEL, isRpcResult } from '../shared/protocol.ts'
import type { BootstrapValue, GitError, LogRequest, LogValue, RpcResult, StatusValue } from '../shared/protocol.ts'

export interface GitClient {
  bootstrap(sessionId: string, signal?: AbortSignal): Promise<RpcResult<BootstrapValue>>
  status(sessionId: string, signal?: AbortSignal): Promise<RpcResult<StatusValue>>
  log(request: LogRequest, signal?: AbortSignal): Promise<RpcResult<LogValue>>
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
  }
}
