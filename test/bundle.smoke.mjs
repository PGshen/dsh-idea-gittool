// 产物 smoke：不依赖浏览器，也不依赖 DSH。
// 校验 lib/client.js 的 __ModuleLoader__ 包装契约与 lib/host.js 的 apply 导出。
// 契约来源：docs/references/dsh-integration-feasibility.md §5.4（TD-1 要盯住的部分）。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

// ---- host bundle ----
const host = await import(new URL('../lib/host.js', import.meta.url))
if (typeof host.apply !== 'function') fail('lib/host.js 没有导出 apply 函数')

if (errors.length > 0) {
  console.error(`bundle smoke 失败：\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.log('bundle smoke 通过')
