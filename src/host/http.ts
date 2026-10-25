// /dsh-git 的 HTTP 路由：直接注册到 webServer（prefix），不用 connection.rpc.handle。
//
// 为什么不用 `ctx.connection.rpc.handle`（DSH 0.2.1-rc.2 实测）：
// 它在 `HostConnectionService.register()` 里用服务自己的 ctx（app root fiber）执行
// `owner.webServer.register(...)`；app root 没有 `webServer` inject，调用会抛
// `cannot get property "webServer" without inject`。0.2.1-rc.2 源码里也没有生产代码
// 使用它。可行的公开路径与 `ui-open-in-app` 一致：自注册 webServer 路由 +
// `connection.requestRejection(req)` 做浏览器鉴权。
//
// 信封由本插件自定（见 src/shared/protocol.ts）：
//   POST /dsh-git/<endpoint>  body: 该方法自己的 payload（JSON）
//   200 { ok: true, value } | { ok: false, error: { code, message, details? } }
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RPC_CHANNEL, RPC_ENDPOINTS } from '../shared/protocol.ts'
import type { RpcResult } from '../shared/protocol.ts'
import type { GitRpcHandler } from './rpc.ts'

/** 请求体上限：payload 只含 sessionId / 游标 / limit，256 KiB 足够且能挡住恶意体。 */
const MAX_BODY_BYTES = 256 * 1024

/** 单次 HTTP 请求的最长生命周期；git 自身另有 8s 超时。 */
const REQUEST_TIMEOUT_MS = 15_000

interface RequestRejectionSource {
  requestRejection(request: IncomingMessage): number | undefined
}

interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function invalidPayload(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'git/invalid-payload', message } }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 注册 `/dsh-git` 前缀路由。
 * @param ctx - Host 插件 context（需要有 `connection` 与 `webServer` 能力）。
 * @param handler - 端点处理器（永不 reject）。
 */
export function registerRpcRoutes(ctx: Context, handler: GitRpcHandler): void {
  // 用 Reflect.get 读取服务：避免在 `inject` 声明之外触碰代理属性。
  const connection = (): RequestRejectionSource | undefined =>
    Reflect.get(ctx, 'connection') as RequestRejectionSource | undefined

  ctx.inject(['webServer'], (webCtx) => {
    const server = Reflect.get(webCtx, 'webServer') as WebServerLike | undefined
    if (server === undefined) return
    webCtx.effect(() => server.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: async (req, res) => {
        // 与 /api 通道一致的浏览器鉴权：未认证直接失败，不落业务代码。
        const rejection = connection()?.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        const pathname = new URL(String(req.url), 'http://dsh.internal').pathname
        const endpoint = pathname.slice(RPC_CHANNEL.length + 1)
        const known = (RPC_ENDPOINTS as readonly string[]).includes(endpoint)
        if (!known) {
          sendJson(res, 404, invalidPayload('unknown RPC endpoint'))
          return
        }
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req)) as unknown
        } catch (error) {
          sendJson(res, 400, invalidPayload(error instanceof Error ? error.message : 'body is not JSON'))
          return
        }
        try {
          const result = await handler(endpoint, payload, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
          sendJson(res, 200, result)
        } catch {
          // handler 契约是永不 reject；这里只是最后一道保险。
          sendJson(res, 200, { ok: false, error: { code: 'git/exec-failed', message: 'RPC handler failed' } })
        }
      },
    }), `dsh-idea-gittool: ${RPC_CHANNEL} routes`)
  })
}
