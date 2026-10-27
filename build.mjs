// 双面产物构建：lib/host.js（ESM，Node）与 lib/client.js（浏览器 bundle）。
// 复刻 DSH 官方的 __ModuleLoader__ 包装契约；契约来源见
// docs/references/dsh-integration-feasibility.md §5.3–5.4（TD-1 需要持续盯住）。
//
// CSS Modules（ADR 0005）：esbuild 的 local-css 处理 *.module.css，样式文本在构建期
// 收集并内联进单个 client.js；factory 执行时注入/更新一个 <style data-plugin-css>（HMR 重跑会替换内容）。
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

/** 构建期 CSS 占位符；写入产物前替换成真正的样式文本。 */
const CSS_TOKEN = '__DSH_GIT_CSS__'

/** 把 esbuild 的 JS + CSS 两个输出合成单个 client.js，并保住 dsh-client-hmr 的 mtime 语义。 */
const emitClientBundle = {
  name: 'emit-client-bundle',
  setup(buildApi) {
    buildApi.onEnd((result) => {
      if (result.errors.length > 0) return
      const files = result.outputFiles ?? []
      const js = files.find(file => file.path.endsWith('.js'))
      if (js === undefined) return
      const css = files.find(file => file.path.endsWith('.css'))?.text ?? ''
      // 函数形式的替换值：CSS 里出现 `$&`、`$'` 等时不会被当成替换模式（评审 M3）。
      const text = js.text.replace(JSON.stringify(CSS_TOKEN), () => JSON.stringify(css))
      // write: false skips esbuild's own mkdir; a fresh checkout (or worktree) has no lib/ yet.
      mkdirSync('lib', { recursive: true })
      writeFileSync('lib/client.js', text)
      if (css.length > 0) writeFileSync('lib/client.css', css)
      else rmSync('lib/client.css', { force: true })
      rmSync('lib/client.js.map', { force: true })
      const now = new Date()
      utimesSync('lib/client.js', now, now)
      console.log(`client bundle ${(text.length / 1024).toFixed(1)} KB (css ${(css.length / 1024).toFixed(1)} KB)`)
    })
  },
}

/** @type {import('esbuild').BuildOptions} */
const client = {
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  // 产物由插件手工合成（CSS 内联），sourcemap 会与真实产物错位；M0/A1 先不产客户端 map。
  sourcemap: false,
  // Minified (owner decision 2026-10-27, after B1 inlined CodeMirror). Banner/footer stay verbatim,
  // so the __ModuleLoader__ wrapper and the CSS placeholder replacement are unaffected.
  // Identifiers are NOT minified: esbuild would also shorten local-css class names to `.ur`-style
  // names that can collide with the host's classes (ADR 0005 relies on `File_name` prefixes).
  minifyWhitespace: true,
  minifySyntax: true,
  write: false,
  external: PLATFORM_MODULES,
  loader: {
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.webp': 'dataurl',
    '.module.css': 'local-css',
    '.css': 'text',
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  // esbuild 0.28 起没有 intro 选项，把 intro 内容并进 banner（顺序不变）。
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
      `var __dshGitCss = ${JSON.stringify(CSS_TOKEN)};`,
      // HMR 会再次执行 factory：复用已有 <style> 并替换内容，既不重复注入也不留旧样式。
      "if (typeof document !== 'undefined' && __dshGitCss.length > 0) {",
      "  var __style = document.querySelector('style[data-plugin-css=\"dsh-idea-gittool\"]');",
      '  if (__style === null) {',
      "    __style = document.createElement('style');",
      "    __style.setAttribute('data-plugin-css', 'dsh-idea-gittool');",
      '    document.head.appendChild(__style);',
      '  }',
      '  __style.textContent = __dshGitCss;',
      '}',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
  plugins: [emitClientBundle],
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
