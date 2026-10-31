// 客户端文案的单一入口：翻译函数类型、`{name}` 插值、React context。
// 组件只经 useT() 取翻译函数；GitBody 把 slot 注入的 `t`（gitWorkbench 命名空间）放进 I18nProvider。
// 纯函数与 store 不产出文本：返回 LocalizedText（键 + 参数），由组件在渲染时翻译，切换语言即时生效。
// 设置里的「显示语言」可以固定中文/英文；跟随 DSH 时原样使用注入的 `t`。
import { createContext, useContext } from 'react'
import type { Context, ReactNode } from 'react'
import { createTranslator, translatorFor } from './localized-text.ts'
import type { Translate } from './localized-text.ts'
import { zh } from './locales.ts'
import { readSettings, useSettings } from './settings.ts'

export { createTranslator, interpolate, render, text, translatorFor } from './localized-text.ts'
export type { LocalizedText, TextParams, Translate } from './localized-text.ts'

// Created on first use: the bundle factory runs before React is available (no module-level React calls).
// The fallback value keeps components renderable outside GitBody (unit tests); production always provides one.
let i18nContext: Context<Translate> | null = null

function context(): Context<Translate> {
  i18nContext ??= createContext<Translate>(createTranslator(zh))
  return i18nContext
}

/** `t` is the DSH translator; the language setting decides whether components get it or a pinned one. */
export function I18nProvider({ t, children }: { t: Translate; children?: ReactNode }): ReactNode {
  const Provider = context().Provider
  return <Provider value={useLocalizedT(t)}>{children}</Provider>
}

/** For slot components that use the injected `t` directly instead of the context. */
export function useLocalizedT(dsh: Translate): Translate {
  return translatorFor(useSettings().language, dsh)
}

/** Outside React (tab definition, shortcuts): reads the setting on every call. */
export function localizedTranslator<T extends Translate>(dsh: T): T {
  return ((key, params) => translatorFor(readSettings().language, dsh)(key, params)) as T
}

/** The active translator; its identity changes when the DSH locale switches. */
export function useT(): Translate {
  return useContext(context())
}
