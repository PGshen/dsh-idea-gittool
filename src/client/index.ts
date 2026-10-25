// Client 半边入口。M0 T1 只建立 __ModuleLoader__ 产物契约；
// 右侧栏 tab 类型、引导页卡片与快捷键在 T2 接入。

/** Cordis 插件名，与 Host 入口保持一致。 */
export const name = 'dsh-idea-gittool'

/** 需要的客户端服务；T2 接入时补充。 */
export const inject: string[] = []

export function apply(): void {
  // T2: sidebarRightTabs / slots / shortcuts / locale 注册
}
