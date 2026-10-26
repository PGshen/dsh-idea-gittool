/**
 * Test translators built from the real dictionaries, so expectations read like the UI does.
 * Components rendered without a provider fall back to Chinese; wrap them with `withLocale`
 * to render another language.
 */
import type { ReactNode } from 'react'
import { I18nProvider } from '../../src/client/i18n.tsx'
import { en, zh } from '../../src/client/locales.ts'
import { createTranslator } from '../../src/client/localized-text.ts'
import type { Translate } from '../../src/client/localized-text.ts'

export const zhT: Translate = createTranslator(zh)
export const enT: Translate = createTranslator(en)

/** Render `node` under a translator (default Chinese). */
export function withLocale(node: ReactNode, t: Translate = zhT): ReactNode {
  return <I18nProvider t={t}>{node}</I18nProvider>
}
