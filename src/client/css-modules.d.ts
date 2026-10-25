// ADR 0005：CSS Modules 的 class map 由 esbuild local-css 生成。
// 这是 ambient 声明文件（没有 import/export），才会被当成全局 wildcard 模块；
// 不能把同样的声明放进 types.d.ts（那是模块文件，会变成模块增强并失效）。
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
