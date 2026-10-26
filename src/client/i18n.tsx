// 客户端文案的单一入口：翻译函数类型、`{name}` 插值、React context。
// 组件只经 useT() 取翻译函数；GitBody 把 slot 注入的 `t`（gitWorkbench 命名空间）放进 I18nProvider。
// 纯函数与 store 不产出文本：返回 LocalizedText（键 + 参数），由组件在渲染时翻译，切换语言即时生效。
import { createContext, useContext } from 'react'
import type { Context, ReactNode } from 'react'
import { createTranslator } from './localized-text.ts'
import type { Translate } from './localized-text.ts'
import { zh } from './locales.ts'

export { createTranslator, interpolate, render, text } from './localized-text.ts'
export type { LocalizedText, TextParams, Translate } from './localized-text.ts'

// Created on first use: the bundle factory runs before React is available (no module-level React calls).
// The fallback value keeps components renderable outside GitBody (unit tests); production always provides one.
let i18nContext: Context<Translate> | null = null

function context(): Context<Translate> {
  i18nContext ??= createContext<Translate>(createTranslator(zh))
  return i18nContext
}

export function I18nProvider({ t, children }: { t: Translate; children?: ReactNode }): ReactNode {
  const Provider = context().Provider
  return <Provider value={t}>{children}</Provider>
}

/** The active translator; its identity changes when the DSH locale switches. */
export function useT(): Translate {
  return useContext(context())
}
