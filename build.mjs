// 双面产物构建：lib/host.js（ESM，Node）与 lib/client.js（浏览器 bundle）。
// 复刻 DSH 官方的 __ModuleLoader__ 包装契约；契约来源见
// docs/references/dsh-integration-feasibility.md §5.3–5.4（TD-1 需要持续盯住）。
//
// CSS Modules（ADR 0005）：esbuild 的 local-css 处理 *.module.css，样式文本在构建期
// 收集并内联进单个 client.js；factory 执行时注入/更新一个 <style data-plugin-css>（HMR 重跑会替换内容）。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { build, context, transform } from 'esbuild'

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

/**
 * 产物包装（契约见 references §5.3–5.4）：banner/footer 原样写进产物，不经过压缩，首行逐字不变。
 * esbuild 0.28 起没有 intro 选项，intro 内容并在 banner 里（顺序不变）。
 */
const BANNER = [
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
].join('\n')
const FOOTER = 'return module.exports; } });'

/**
 * B4c T3：模块体在 CSS 生成之后再压缩一次标识符。local-css 类名此时已是字符串字面量，不受影响
 * （直接在构建里开 minifyIdentifiers 会把类名缩成可能与宿主冲突的短名，ADR 0005）。
 * 包进 IIFE 是为了让 esbuild 把作用域提升到顶层的模块变量也当成局部变量改名；
 * `module`/`exports`/`require` 来自 banner，是自由变量，保持原名。
 */
async function minifyBody(code) {
  const result = await transform(`(() => {\n${code}\n})();`, {
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
    target: 'es2022',
    legalComments: 'none',
  })
  return result.code
}

/** 按需 chunk（B4c T3）：DSH client-modules 只服务与 client.js 同目录、名为 `client.<名字>.js` 的文件。 */
const MERGE_CHUNK = 'client.merge.js'
const CHUNK_BANNER = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, chunk: ${JSON.stringify(MERGE_CHUNK)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

/** 最近一次构建出的 chunk 内容哈希；主包在 banner 之后以注释行记录它（见 emitClientBundle）。 */
let mergeChunkHash = 'pending'

/**
 * DSH 按 client.js 的内容给整个包算版本号，chunk 的 URL 带的也是这个版本。只改了 chunk 时，
 * 主包里的哈希注释随之变化，版本号才会前进，浏览器不会继续用旧 chunk。
 */
function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** 合并窗口的 CodeMirror chunk：不允许带样式（样式全在主包里注入，见 merge-editor-loader.ts）。 */
const emitMergeChunk = {
  name: 'emit-merge-chunk',
  setup(buildApi) {
    buildApi.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const files = result.outputFiles ?? []
      const js = files.find(file => file.path.endsWith('.js'))
      if (js === undefined) return
      if (files.some(file => file.path.endsWith('.css') && file.text.length > 0)) {
        throw new Error(`${MERGE_CHUNK} must not import CSS: keep styles in the main bundle`)
      }
      const text = `${CHUNK_BANNER}\n${await minifyBody(js.text)}\n${FOOTER}\n`
      mkdirSync('lib', { recursive: true })
      writeFileSync(`lib/${MERGE_CHUNK}`, text)
      mergeChunkHash = hashOf(text)
      console.error(`merge chunk ${(text.length / 1024).toFixed(1)} KB`)
    })
  },
}

/** 把 esbuild 的 JS + CSS 两个输出合成单个 client.js，并保住 dsh-client-hmr 的 mtime 语义。 */
const emitClientBundle = {
  name: 'emit-client-bundle',
  setup(buildApi) {
    buildApi.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const files = result.outputFiles ?? []
      const js = files.find(file => file.path.endsWith('.js'))
      if (js === undefined) return
      const css = files.find(file => file.path.endsWith('.css'))?.text ?? ''
      // 函数形式的替换值：CSS 里出现 `$&`、`$'` 等时不会被当成替换模式（评审 M3）。
      const banner = BANNER.replace(JSON.stringify(CSS_TOKEN), () => JSON.stringify(css))
      const text = `${banner}\n// ${MERGE_CHUNK} ${mergeChunkHash}\n${await minifyBody(js.text)}\n${FOOTER}\n`
      // write: false skips esbuild's own mkdir; a fresh checkout (or worktree) has no lib/ yet.
      mkdirSync('lib', { recursive: true })
      writeFileSync('lib/client.js', text)
      if (css.length > 0) writeFileSync('lib/client.css', css)
      else rmSync('lib/client.css', { force: true })
      rmSync('lib/client.js.map', { force: true })
      const now = new Date()
      utimesSync('lib/client.js', now, now)
      console.error(`client bundle ${(text.length / 1024).toFixed(1)} KB (css ${(css.length / 1024).toFixed(1)} KB)`)
    })
  },
}

/** Options shared by the client entry and its chunk. */
const browser = {
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  // 产物由插件手工合成（CSS 内联），sourcemap 会与真实产物错位；M0/A1 先不产客户端 map。
  sourcemap: false,
  // Minified (owner decision 2026-10-27, after B1 inlined CodeMirror). Banner/footer stay verbatim,
  // so the __ModuleLoader__ wrapper and the CSS placeholder replacement are unaffected.
  // Identifiers are minified afterwards (minifyBody), never here: esbuild would also shorten
  // local-css class names to `.ur`-style names that can collide with the host's classes (ADR 0005).
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
}

/** @type {import('esbuild').BuildOptions} */
const mergeChunk = {
  ...browser,
  entryPoints: ['src/client/pages/merge-editor.ts'],
  outfile: `lib/${MERGE_CHUNK}`,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [emitMergeChunk],
}

/**
 * esbuild bundles the target of a dynamic import even in a branch the define makes dead; mark the
 * loader's source-only fallback external so CodeMirror cannot come back into client.js.
 */
const keepMergeEditorOut = {
  name: 'keep-merge-editor-out',
  setup(buildApi) {
    buildApi.onResolve({ filter: /\/merge-editor\.ts$/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined)
  },
}

/** @returns {import('esbuild').BuildOptions} */
function clientOptions() {
  return {
    ...browser,
    entryPoints: ['src/client/index.ts'],
    outfile: 'lib/client.js',
    // merge-editor-loader.ts takes the chunk path (`require.async`); its source-only dynamic import
    // becomes dead code (and is kept external by keepMergeEditorOut), so CodeMirror stays out.
    define: { 'process.env.NODE_ENV': '"production"', __DSH_GIT_MERGE_CHUNK__: 'true' },
    plugins: [keepMergeEditorOut, emitClientBundle],
  }
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
  // client.js records the chunk hash, so a chunk rebuild that changes it rebuilds the client too.
  await build(mergeChunk)
  let clientCtx = await context(clientOptions())
  await clientCtx.watch()
  let chunkHash = mergeChunkHash
  const chunkCtx = await context({
    ...mergeChunk,
    plugins: [emitMergeChunk, {
      name: 'rebuild-client-on-chunk-change',
      setup(buildApi) {
        buildApi.onEnd(async () => {
          if (mergeChunkHash === chunkHash) return
          chunkHash = mergeChunkHash
          await clientCtx.dispose()
          clientCtx = await context(clientOptions())
          await clientCtx.watch()
        })
      },
    }],
  })
  await chunkCtx.watch()
  const hostCtx = await context(host)
  await hostCtx.watch()
  console.error(`watching src/host → lib/host.js, src/client → lib/client.js + lib/${MERGE_CHUNK}`)
} else {
  await build(mergeChunk)
  await build(clientOptions())
  await build(host)
  console.error(`built lib/host.js, lib/client.js and lib/${MERGE_CHUNK}`)
}
