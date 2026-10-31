// Display language setting: follow DSH, or pin the workbench to Chinese or English.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, localizedTranslator, useLocalizedT, useT } from '../../src/client/i18n.tsx'
import { translatorFor } from '../../src/client/localized-text.ts'
import { resetSettingsForTest, writeSettings } from '../../src/client/settings.ts'
import { enT, zhT } from './i18n-helpers.tsx'

beforeEach(() => { resetSettingsForTest() })
afterEach(() => { resetSettingsForTest() })

describe('translatorFor', () => {
  it('passes the DSH translator through on auto', () => {
    expect(translatorFor('auto', enT)).toBe(enT)
  })

  it('pins the dictionary otherwise, with a stable identity', () => {
    expect(translatorFor('zh', enT)('settings.done')).toBe('完成')
    expect(translatorFor('en', zhT)('settings.done')).toBe('Done')
    expect(translatorFor('en', zhT)).toBe(translatorFor('en', enT))
  })
})

describe('localizedTranslator', () => {
  it('reads the setting on every call', () => {
    const t = localizedTranslator(zhT)
    expect(t('settings.done')).toBe('完成')
    writeSettings({ language: 'en' })
    expect(t('settings.done')).toBe('Done')
    expect(t('settings.seconds', { n: 3 })).toBe('3 s')
  })
})

function Done(): string {
  return useT()('settings.done')
}

function Direct({ t }: { t: typeof zhT }): string {
  return useLocalizedT(t)('settings.done')
}

describe('I18nProvider / useLocalizedT', () => {
  it('follow the DSH translator on auto and the setting otherwise', () => {
    expect(renderToStaticMarkup(<I18nProvider t={enT}><Done /></I18nProvider>)).toBe('Done')
    expect(renderToStaticMarkup(<Direct t={enT} />)).toBe('Done')
    writeSettings({ language: 'zh' })
    expect(renderToStaticMarkup(<I18nProvider t={enT}><Done /></I18nProvider>)).toBe('完成')
    expect(renderToStaticMarkup(<Direct t={enT} />)).toBe('完成')
  })
})
