// Host 半边入口：注册 /dsh-git 的 HTTP 路由并装配 git RPC 运行时（可行性调研 §6–§9）。
// 运行时零依赖（ARCHITECTURE.md R4）：能力一律从 ctx 取，node_modules 只允许 import type。

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'

import type { SessionsLike } from './repo-resolver.ts'
import type { RpcDeps } from './rpc.ts'
import type { FsServiceLike, FsWatch } from './watch.ts'
import { fsWatchFromService } from './watch.ts'
import { createGitConsole } from './console.ts'
import { createGitExecutable } from './git-executable.ts'
import { createGitRunner, instrumentGitRunner } from './git-executor.ts'
import { createRpcRuntime } from './rpc.ts'
import { registerRpcRoutes } from './http.ts'

/** Cordis 插件名，用于日志与生命周期诊断。 */
export const name = 'dsh-idea-gittool'

/**
 * 必需服务：浏览器鉴权（connection）与 git 执行世界（subprocess）。
 * `webServer` 不在模块级 inject 里：路由注册在 `ctx.inject(['webServer'])` 的子作用域中完成，
 * 与 `ui-open-in-app` 的先例一致（原因见 http.ts 顶部注释）。
 */
export const inject = ['connection', 'subprocess']

export function apply(ctx: Context): void {
  // 插件卸载时统一取消所有 watch（watch 的 AbortSignal 与 runtime.dispose 都挂在这里）。
  const watchLifetime = new AbortController()
  // Git 控制台（设计 §12）：所有 git 调用经 instrumentGitRunner 统一记录进进程内环形缓冲。
  const gitConsole = createGitConsole()
  // B4d T2: PATH git unless the client sends a validated path (kept in memory only).
  const gitExecutable = createGitExecutable(ctx.subprocess)
  const deps: RpcDeps = {
    // B4c T2: run git's own binary (`--exec-path`), not a PATH launcher such as macOS xcrun.
    runner: instrumentGitRunner(createGitRunner(ctx.subprocess, { directBinary: true, executable: gitExecutable }), gitConsole),
    gitExecutable,
    console: gitConsole,
    // 惰性读取：composition 可能在本插件之后加载这些服务；缺失服务不等于错误。
    // `ctx.sessions` 的类型被 DSH 的 client 半边声明合并成 ISessions（同一个 Context
    // 被两侧 augmentation，skipLibCheck 下后者胜出）；Host 运行时实际是 SessionStore，
    // 因此这里显式收窄到本插件需要的结构子集。
    sessions: () => ctx.get('sessions') as unknown as SessionsLike | undefined,
    workingDirectory: () => ctx.get('workingDirectory'),
    sessionPersistence: () => ctx.get('sessionPersistence'),
    sandboxPolicy: () => ctx.get('sandboxPolicy'),
    sandbox: () => ctx.get('sandbox'),
    // web 组合由 fs-sandbox 提供 `fs`；缺失时返回 undefined，watchRepo 降级，客户端退回轮询。
    // TD-4：fs.watch 只接受 resolve() 出的目标，旧适配器传字符串导致 watch 一直失败。
    fsWatch: (): FsWatch | undefined => {
      const fs = ctx.get('fs') as unknown as FsServiceLike | undefined
      if (fs === undefined) return undefined
      return fsWatchFromService(fs, watchLifetime.signal)
    },
  }
  const runtime = createRpcRuntime(deps)
  // 注册 /dsh-git 前缀路由并管理生命周期（见 http.ts 顶部关于 rpc.handle 的说明）。
  registerRpcRoutes(ctx, runtime.handler)
  ctx.effect(() => () => {
    watchLifetime.abort()
    void runtime.dispose()
  }, 'dsh-idea-gittool: dispose')
}
