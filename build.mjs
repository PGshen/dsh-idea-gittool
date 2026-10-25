// 双面产物构建：lib/host.js（ESM，Node）与 lib/client.js（浏览器 bundle）。
// 复刻 DSH 官方的 __ModuleLoader__ 包装契约；契约来源见
// docs/references/dsh-integration-feasibility.md §5.3–5.4（TD-1 需要持续盯住）。
import { readFileSync, utimesSync } from 'node:fs'
import { build, context } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const ID = pkg.name

// 与 DSH 的 packages/client/web/src/platform.ts（PLATFORM_MODULES）保持一致。
// 升级 DSH 后要先核对这个清单，再跑 test/bundle.smoke.mjs。
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** @type {import('esbuild').BuildOptions} */
const client = {
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: PLATFORM_MODULES,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  // esbuild 0.28 起没有 intro 选项，把 intro 内容并进 banner（顺序不变）。
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
  plugins: [
    {
      // dsh-client-hmr 按 mtime/ctime/size 判断产物是否更新，构建完要戳一下。
      name: 'stamp-client-bundle',
      setup(buildApi) {
        buildApi.onEnd((result) => {
          if (result.errors.length > 0) return
          const now = new Date()
          utimesSync('lib/client.js', now, now)
        })
      },
    },
  ],
}

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/host.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Host 运行时零依赖（ARCHITECTURE.md R4）：只留 node:*，其余依赖必须由 ctx 提供。
  packages: 'external',
  sourcemap: true,
}

if (process.argv.includes('--watch')) {
  const clientCtx = await context(client)
  await clientCtx.watch()
  const hostCtx = await context(host)
  await hostCtx.watch()
  console.log('watching src/host → lib/host.js, src/client → lib/client.js')
} else {
  await build(client)
  await build(host)
  console.log('built lib/host.js and lib/client.js')
}
