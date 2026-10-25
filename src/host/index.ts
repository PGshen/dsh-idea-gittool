// Host 半边入口：把 /dsh-git 的 RPC 处理器挂到 connection 上（可行性调研 §6、§7）。
// 运行时零依赖（ARCHITECTURE.md R4）：能力一律从 ctx 取，node_modules 只允许 import type。

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'

import { RPC_CHANNEL } from '../shared/protocol.ts'
import type { SessionsLike } from './repo-resolver.ts'
import type { RpcDeps } from './rpc.ts'
import { createGitRunner } from './git-executor.ts'
import { createRpcHandler } from './rpc.ts'

/** Cordis 插件名，用于日志与生命周期诊断。 */
export const name = 'dsh-idea-gittool'

/** 必需服务：通道载体与 git 执行世界；会话相关服务可选（ctx.get 惰性读取）。 */
export const inject = ['connection', 'subprocess']

export function apply(ctx: Context): void {
  const deps: RpcDeps = {
    runner: createGitRunner(ctx.subprocess),
    // 惰性读取：composition 可能在本插件之后加载这些服务；缺失服务不等于错误。
    // `ctx.sessions` 的类型被 DSH 的 client 半边声明合并成 ISessions（同一个 Context
    // 被两侧 augmentation，skipLibCheck 下后者胜出）；Host 运行时实际是 SessionStore，
    // 因此这里显式收窄到本插件需要的结构子集。
    sessions: () => ctx.get('sessions') as unknown as SessionsLike | undefined,
    workingDirectory: () => ctx.get('workingDirectory'),
    sessionPersistence: () => ctx.get('sessionPersistence'),
    sandboxPolicy: () => ctx.get('sandboxPolicy'),
  }
  const handler = createRpcHandler(deps)
  ctx.effect(() => ctx.connection.rpc.handle(RPC_CHANNEL, handler), 'dsh-idea-gittool: rpc')
}
