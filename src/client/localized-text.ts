// React-free half of the client i18n: translator type, `{name}` interpolation and LocalizedText.
// Stores and pure helpers import this file; components use i18n.tsx (context + useT).
import type { WritePolicyValue } from '../shared/protocol.ts'
import { READ_ONLY_REASON_KEY, en, zh } from './locales.ts'
import type { GitWorkbenchKey } from './locales.ts'
import type { Language } from './settings.ts'

/** Placeholder values for `{name}` slots in a dictionary template. */
export type TextParams = Record<string, unknown>

/** Translator bound to the `gitWorkbench` namespace. */
export type Translate = (key: GitWorkbenchKey, params?: TextParams) => string

/** Text produced outside React (stores, pure helpers): translated at render time. */
export interface LocalizedText {
  key: GitWorkbenchKey
  params?: TextParams
}

/**
 * Replace `{name}` placeholders with params; unknown names stay as written.
 * Same rule as the DSH locale service, so dictionary templates behave alike in tests and at runtime.
 */
export function interpolate(template: string, params?: TextParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

/** Build a translator over one complete dictionary (tests, and the fallback context value). */
export function createTranslator(dictionary: Readonly<Record<GitWorkbenchKey, string>>): Translate {
  return (key, params) => interpolate(dictionary[key], params)
}

const pinned: Partial<Record<Exclude<Language, 'auto'>, Translate>> = {}

/**
 * The translator for the language setting: `auto` keeps the DSH one, `zh`/`en` pin a dictionary.
 * Pinned translators are built once, so their identity only changes with the setting.
 */
export function translatorFor(language: Language, dsh: Translate): Translate {
  if (language === 'auto') return dsh
  pinned[language] ??= createTranslator(language === 'zh' ? zh : en)
  return pinned[language]
}

/** Shorthand for building a LocalizedText. */
export function text(key: GitWorkbenchKey, params?: TextParams): LocalizedText {
  return params === undefined ? { key } : { key, params }
}

/** Translate a LocalizedText with the given translator. */
export function render(t: Translate, value: LocalizedText): string {
  return t(value.key, value.params)
}

/**
 * Localized read-only explanation: the text for `reasonCode`, else the Host's `reason`
 * (older Host without codes), else a generic fallback. Null when the repository is writable.
 */
export function readOnlyMessage(
  t: Translate,
  policy: WritePolicyValue,
  fallback: GitWorkbenchKey = 'readOnly.fallback',
): string | null {
  if (policy.mode === 'read-write') return null
  if (policy.reasonCode !== undefined) return t(READ_ONLY_REASON_KEY[policy.reasonCode])
  return policy.reason ?? t(fallback)
}
