// Host 半边入口。M0 T1 只建立产物契约；RPC 处理器在 T3 接入。
// 运行时零依赖（ARCHITECTURE.md R4）：DSH 能力一律从 ctx 取，只允许 import type。

/** Cordis 插件名，用于日志与生命周期诊断。 */
export const name = 'dsh-idea-gittool'

/** 需要的 DSH 服务；T3 接入 connection 后在此声明。 */
export const inject: string[] = []

export function apply(): void {
  // T3: ctx.connection.rpc.handle(RPC_CHANNEL, handler)
}
