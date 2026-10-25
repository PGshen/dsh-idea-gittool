/**
 * 分层依赖契约（docs/ARCHITECTURE.md §3 的机器版本）。
 * 规则名 R1–R4 与 ARCHITECTURE.md 的编号一一对应。
 * M0 计划安装 dependency-cruiser 后，由 package.json 的 `layers` 脚本接入 `make check`。
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'R1-client-not-import-host',
      severity: 'error',
      comment: 'Client 与 Host 是独立 bundle，客户端不得引用 Host 代码',
      from: { path: '^src/client' },
      to: { path: '^src/host' },
    },
    {
      name: 'R2-host-not-import-client',
      severity: 'error',
      comment: 'Host 不得引用浏览器端代码',
      from: { path: '^src/host' },
      to: { path: '^src/client' },
    },
    {
      name: 'R3-shared-not-import-app',
      severity: 'error',
      comment: 'shared 是两端共用的纯类型/协议层，不得反向依赖 host 或 client',
      from: { path: '^src/shared' },
      to: { path: '^src/(host|client)' },
    },
    {
      name: 'R4-host-runtime-zero-deps',
      severity: 'error',
      comment:
        'Host 运行时零依赖：能力从 ctx 取，node_modules 里的包只允许 import type（编译后擦除）',
      from: { path: '^src/host' },
      to: {
        path: '^node_modules/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'R5-browser-no-node-core',
      severity: 'error',
      comment: 'Client 与 shared 随浏览器产物运行，不能依赖 node:* 内置模块',
      from: { path: '^src/(client|shared)' },
      to: { dependencyTypes: ['core'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^lib/' },
    tsPreCompilationDeps: true,
  },
}
