// B4a T2 settings sheet: every setting with its current value, control → patch mapping, repo bar entry.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RepoBar } from '../../../src/client/pages/RepoBar.tsx'
import { SettingsSheetView, settingsPatchFor } from '../../../src/client/pages/SettingsSheet.tsx'
import type { SettingsSheetViewProps } from '../../../src/client/pages/SettingsSheet.tsx'
import { DEFAULT_SETTINGS } from '../../../src/client/settings.ts'
import { enT, withLocale, zhT } from '../i18n-helpers.tsx'

function render(overrides: Partial<SettingsSheetViewProps> = {}, t = zhT): string {
  const props: SettingsSheetViewProps = {
    t,
    settings: { ...DEFAULT_SETTINGS },
    onChange: () => {},
    onReset: () => {},
    onClose: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(withLocale(<SettingsSheetView {...props} />, t))
}

/** The opening tag of the element marked `data-setting="<name>"`. */
function control(html: string, name: string): string {
  const match = new RegExp(`<[^>]*data-setting="${name}"[^>]*>`).exec(html)
  if (match === null) throw new Error(`no control ${name}`)
  return match[0]
}

describe('SettingsSheetView', () => {
  it('lists every sheet setting as a labelled dialog', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('data-integrate-sheet="settings"')
    for (const name of ['autoRefresh', 'refreshIntervalSec', 'diffMode', 'logPageSize', 'afterCommit', 'dateFormat', 'compact', 'autoOpenConflicts', 'mergeAutoApplyNonConflicting', 'blameRenderer']) {
      expect(html, name).toContain(`data-setting="${name}"`)
    }
    expect(html).not.toContain('data-setting="changelistGrouping"')
    expect(html).toContain('设置')
    expect(html).toContain('恢复默认')
  })

  it('shows the defaults: switches on/off and the selected options', () => {
    const html = render()
    expect(control(html, 'autoRefresh')).toContain('role="switch"')
    expect(control(html, 'autoRefresh')).toContain('checked=""')
    expect(control(html, 'compact')).not.toContain('checked=""')
    expect(control(html, 'autoOpenConflicts')).toContain('checked=""')
    expect(control(html, 'mergeAutoApplyNonConflicting')).not.toContain('checked=""')
    expect(control(html, 'blameRenderer')).not.toContain('checked=""')
    expect(html).toMatch(/<option value="3" selected="">/)
    expect(html).toMatch(/<option value="100" selected="">/)
    expect(html).toMatch(/<option value="unified" selected="">/)
    expect(html).toMatch(/<option value="stay" selected="">/)
    expect(html).toMatch(/<option value="absolute" selected="">/)
  })

  it('offers 1..10 seconds and 50/100/200 rows only', () => {
    const html = render()
    const interval = /data-setting="refreshIntervalSec"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? ''
    expect([...interval.matchAll(/<option value="(\d+)"/g)].map(m => m[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    const pages = /data-setting="logPageSize"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? ''
    expect([...pages.matchAll(/<option value="(\d+)"/g)].map(m => m[1])).toEqual(['50', '100', '200'])
  })

  it('disables the interval while auto refresh is off', () => {
    expect(control(render(), 'refreshIntervalSec')).not.toContain('disabled')
    expect(control(render({ settings: { ...DEFAULT_SETTINGS, autoRefresh: false } }), 'refreshIntervalSec')).toContain('disabled')
  })

  it('reflects non-default values', () => {
    const html = render({ settings: { ...DEFAULT_SETTINGS, compact: true, blameRenderer: true, diffMode: 'split', dateFormat: 'relative', afterCommit: 'log', logPageSize: 50, refreshIntervalSec: 9 } })
    expect(control(html, 'compact')).toContain('checked=""')
    expect(control(html, 'blameRenderer')).toContain('checked=""')
    expect(html).toMatch(/<option value="split" selected="">/)
    expect(html).toMatch(/<option value="relative" selected="">/)
    expect(html).toMatch(/<option value="log" selected="">/)
    expect(html).toMatch(/<option value="50" selected="">/)
    expect(html).toMatch(/<option value="9" selected="">/)
  })

  it('states that destructive confirmations are always on and explains the Blame renderer', () => {
    const html = render()
    expect(html).toContain('data-setting-readonly="confirmDestructive"')
    expect(html).toContain('始终开启')
    expect(html).toContain('默认显示 Blame')
  })

  it('renders in English', () => {
    const html = render({}, enT)
    expect(html).toContain('Settings')
    expect(html).toContain('Restore defaults')
  })
})

describe('settingsPatchFor', () => {
  it('turns control values into typed patches', () => {
    expect(settingsPatchFor('autoRefresh', false)).toEqual({ autoRefresh: false })
    expect(settingsPatchFor('refreshIntervalSec', '7')).toEqual({ refreshIntervalSec: 7 })
    expect(settingsPatchFor('logPageSize', '200')).toEqual({ logPageSize: 200 })
    expect(settingsPatchFor('diffMode', 'split')).toEqual({ diffMode: 'split' })
    expect(settingsPatchFor('afterCommit', 'log')).toEqual({ afterCommit: 'log' })
    expect(settingsPatchFor('dateFormat', 'relative')).toEqual({ dateFormat: 'relative' })
    expect(settingsPatchFor('blameRenderer', true)).toEqual({ blameRenderer: true })
  })

  it('drops values outside the allowed set', () => {
    expect(settingsPatchFor('logPageSize', '75')).toEqual({})
    expect(settingsPatchFor('refreshIntervalSec', 'x')).toEqual({})
    expect(settingsPatchFor('diffMode', 'sideways')).toEqual({})
    expect(settingsPatchFor('compact', 'yes')).toEqual({})
  })
})

describe('RepoBar settings entry', () => {
  it('shows "Settings…" in the ⋯ menu when wired', () => {
    const base = { repoRoot: '/r', onRefresh: () => {}, onOpenConsole: () => {}, defaultMenuOpen: true }
    expect(renderToStaticMarkup(withLocale(<RepoBar {...base} />))).not.toContain('data-repo-settings')
    const html = renderToStaticMarkup(withLocale(<RepoBar {...base} onSettings={() => {}} />))
    expect(html).toContain('data-repo-settings')
    expect(html).toContain('设置…')
  })
})
