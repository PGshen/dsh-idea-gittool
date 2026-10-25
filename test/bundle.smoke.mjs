// 产物 smoke：不依赖浏览器，也不依赖 DSH。
// 校验 lib/client.js 的 __ModuleLoader__ 包装契约与 lib/host.js 的 apply 导出。
// 契约来源：docs/references/dsh-integration-feasibility.md §5.4（TD-1 要盯住的部分）。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
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
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window,
  console,
})

if (registration === undefined) {
  fail('lib/client.js 没有调用 window.__ModuleLoader__.load')
} else {
  if (registration.id !== pkg.name) fail(`client bundle id 是 ${registration.id}，应为 ${pkg.name}`)
  if (typeof registration.factory !== 'function') {
    fail('client bundle 缺少 factory 函数')
  } else {
    const requested = []
    const mod = registration.factory((name) => {
      requested.push(name)
      throw new Error(`未预期的 require：${name}`)
    })
    if (mod === null || typeof mod !== 'object') {
      fail('client factory 没有返回模块对象')
    } else {
      if (typeof mod.apply !== 'function') fail('client 模块缺少 apply 函数')
      if (!Array.isArray(mod.inject)) fail('client 模块缺少 inject 数组')
    }
    if (requested.length > 0) fail(`client 模块加载期不应 require：${requested.join(', ')}`)
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
