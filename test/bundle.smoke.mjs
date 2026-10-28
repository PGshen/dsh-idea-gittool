// 产物 smoke：不依赖浏览器，也不依赖 DSH。
// 校验 lib/client.js 的 __ModuleLoader__ 包装契约与 lib/host.js 的 apply 导出。
// 契约来源：docs/references/dsh-integration-feasibility.md §5.4（TD-1 要盯住的部分）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// factory(require) 里的 require 就是宿主注入的 baseline 模块表；未知请求必须失败。
const PLATFORM_MODULES = new Set([
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
])
const errors = []
const fail = (message) => errors.push(message)

// 设计 §16.8 包体积预算：client.js ≤ 250 KB gzip（B4c T3）。
const CLIENT_GZIP_MAX = 250 * 1024
const clientGzip = gzipSync(readFileSync(new URL('../lib/client.js', import.meta.url))).length
if (clientGzip > CLIENT_GZIP_MAX) fail(`lib/client.js gzip ${clientGzip} 字节，超出预算 ${CLIENT_GZIP_MAX}`)

// ---- client bundle ----
let registration
const window = {
  __ModuleLoader__: {
    load: (value) => {
      registration = value
    },
  },
}
// 保留沙箱对象：后面的 HMR 检查要往里放一个假 document。
const sandbox = { window, console }
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)

if (registration === undefined) {
  fail('lib/client.js 没有调用 window.__ModuleLoader__.load')
} else {
  if (registration.id !== pkg.name) fail(`client bundle id 是 ${registration.id}，应为 ${pkg.name}`)
  if (typeof registration.factory !== 'function') {
    fail('client bundle 缺少 factory 函数')
  } else {
    const requested = []
    // 宿主注入的 baseline 模块表在真实运行时有值；smoke 只关心 require 的集合是否合法，
    // 因此给外部模块返回空对象，未知请求仍然失败。
    const mod = registration.factory((name) => {
      requested.push(name)
      if (!PLATFORM_MODULES.has(name)) throw new Error(`未预期的 require：${name}`)
      return {}
    })
    if (mod === null || typeof mod !== 'object') {
      fail('client factory 没有返回模块对象')
    } else {
      if (typeof mod.apply !== 'function') fail('client 模块缺少 apply 函数')
      if (!Array.isArray(mod.inject)) fail('client 模块缺少 inject 数组')
    }
    // ADR 0005：样式必须在 factory 内注入一次，且 class 名是 local-css 哈希。
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    if (!source.includes('data-plugin-css')) fail('client.js 缺少 data-plugin-css 样式注入')
    if (!/\.[a-zA-Z][\w-]*_[a-z0-9]{4,}/u.test(source)) fail('client.js 没有 CSS Modules 哈希类名')
    // Shipped minified (owner decision 2026-10-27): an unminified build has tens of thousands of lines.
    const lineCount = source.split('\n').length
    if (lineCount > 500) fail(`client.js 应为压缩产物，实际 ${lineCount} 行`)
    // ...but local-css names must keep their `File_name` prefix: identifier minification would
    // shorten them to `.ur`-style names that can collide with the host's own classes.
    const shortClass = /[}"]\.[a-z]{1,3}[{,:.\s]/u.exec(source)
    if (shortClass !== null) fail(`client.js 含无前缀的短 CSS 类名（${shortClass[0]}），不要开启 minifyIdentifiers`)
    // HMR：factory 再次执行时必须更新已有 <style> 的内容，而不是跳过（否则改 CSS 要整页刷新）。
    const styles = []
    const fakeDocument = {
      // B1 T6: CodeMirror (inlined) probes `document.documentElement.style` at module init.
      documentElement: { style: {} },
      querySelector: (selector) =>
        styles.find(style => selector.includes(`"${style.attrs['data-plugin-css']}"`)) ?? null,
      createElement: () => ({ attrs: {}, textContent: '', setAttribute(key, value) { this.attrs[key] = value } }),
      head: { appendChild: (style) => { styles.push(style) } },
    }
    sandbox.document = fakeDocument
    try {
      registration.factory(() => ({}))
      const first = styles[0]
      if (first !== undefined) first.textContent = 'stale'
      registration.factory(() => ({}))
      if (styles.length !== 1) fail(`factory 重复执行后应只有 1 个插件 <style>，实际 ${styles.length}`)
      else if (styles[0].textContent === 'stale' || styles[0].textContent === '') fail('factory 重复执行（HMR）没有更新插件 <style> 内容')
    } finally {
      delete sandbox.document
    }
    if (requested.length > 0 && requested.some(name => !PLATFORM_MODULES.has(name))) {
      fail(`client 模块加载期 require 了非基线模块：${requested.join(', ')}`)
    }
  }
}

// ---- merge-window chunk (B4c T3) ----
// DSH client-modules serves `client.<name>.js` next to client.js and loads it through the factory's
// `require.async`; the chunk registers itself with the same id plus `chunk`.
const MERGE_CHUNK = 'client.merge.js'
const mainSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!mainSource.includes(`require.async("./${MERGE_CHUNK}")`)) fail(`client.js 没有通过 require.async 加载 ${MERGE_CHUNK}`)
if (mainSource.includes('cm-editor') || mainSource.includes('merge-editor.ts')) fail('client.js 仍然包含 CodeMirror 或合并编辑器源码')
// The package revision DSH computes from client.js must move when only the chunk changed.
let chunkSource
try {
  chunkSource = readFileSync(new URL(`../lib/${MERGE_CHUNK}`, import.meta.url), 'utf8')
} catch {
  fail(`缺少 lib/${MERGE_CHUNK}`)
}
if (chunkSource !== undefined) {
  const recorded = /^\/\/ client\.merge\.js ([0-9a-f]{12})$/mu.exec(mainSource)?.[1]
  const actual = createHash('sha256').update(chunkSource).digest('hex').slice(0, 12)
  if (recorded !== actual) fail(`client.js 记录的 chunk 哈希 ${recorded} 与 lib/${MERGE_CHUNK} 的 ${actual} 不一致`)
  let chunkRegistration
  const chunkWindow = { __ModuleLoader__: { load: (value) => { chunkRegistration = value } } }
  // CodeMirror probes `document.documentElement.style` when its modules initialise.
  vm.runInNewContext(chunkSource, { window: chunkWindow, console, document: { documentElement: { style: {} } } })
  if (chunkRegistration === undefined) fail(`lib/${MERGE_CHUNK} 没有调用 window.__ModuleLoader__.load`)
  else {
    if (chunkRegistration.id !== pkg.name) fail(`chunk id 是 ${chunkRegistration.id}，应为 ${pkg.name}`)
    if (chunkRegistration.chunk !== MERGE_CHUNK) fail(`chunk 字段是 ${chunkRegistration.chunk}，应为 ${MERGE_CHUNK}`)
    const chunkRequested = []
    const chunkExports = chunkRegistration.factory((name) => {
      chunkRequested.push(name)
      if (!PLATFORM_MODULES.has(name)) throw new Error(`未预期的 require：${name}`)
      return {}
    })
    if (typeof chunkExports?.createMergePane !== 'function') fail(`${MERGE_CHUNK} 没有导出 createMergePane`)
    if (chunkRequested.some(name => !PLATFORM_MODULES.has(name))) fail(`${MERGE_CHUNK} require 了非基线模块：${chunkRequested.join(', ')}`)
  }
}

// ---- host bundle ----
const host = await import(new URL('../lib/host.js', import.meta.url))
if (typeof host.apply !== 'function') fail('lib/host.js 没有导出 apply 函数')

if (errors.length > 0) {
  console.error(`bundle smoke 失败：\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.log(`bundle smoke 通过（client.js gzip ${(clientGzip / 1024).toFixed(1)} KB）`)
