// B1 acceptance demo: CSS that names a DSH variable which does not exist at runtime silently
// renders nothing (transparent chunk tones, default fonts). Guard the B1 styles against the known
// missing names; A1–A3 styles still use them and are tracked in docs/plans/TODO.md (P2).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = join(import.meta.dirname, '../../../src/client')

/** DSH tokens that do not exist at runtime (checked in the DSH web GUI, 2026-10-27) → the real ones. */
const MISSING_TOKENS: Readonly<Record<string, string>> = {
  '--dsw-alias-state-success': '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn': '--dsw-alias-state-warn-primary',
  '--dsw-font-mono': '--dsw-font-markdown-code-block-font-family',
  '--dsw-alias-interactive-bg-selected': '--dsw-alias-interactive-bg-active',
}

/** Styles in scope of the guard (B1, B2); widen to every file once A1–A3 are migrated. */
const GUARDED = /^pages\/(MergeWindow[^/]*|ConflictsPage|BlameView|HistoryPages|InteractiveRebasePage)\.module\.css$/

interface TokenUse { file: string; name: string; fallback: boolean }

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.module.css') ? [path] : []
  })
}

/** Every `var(--dsw-…)` in the client's CSS modules, with whether it carries a fallback. */
function dswTokenUses(): TokenUse[] {
  const uses: TokenUse[] = []
  for (const path of cssFiles(CLIENT_ROOT)) {
    const file = relative(CLIENT_ROOT, path).split('\\').join('/')
    const css = readFileSync(path, 'utf8')
    for (const match of css.matchAll(/var\(\s*(--dsw-[\w-]+)\s*(,)?/g)) {
      uses.push({ file, name: match[1] ?? '', fallback: match[2] !== undefined })
    }
  }
  return uses
}

describe('DSH CSS tokens', () => {
  const uses = dswTokenUses()

  it('scans the guarded B1/B2 styles', () => {
    const files = new Set(uses.filter(use => GUARDED.test(use.file)).map(use => use.file))
    expect([...files].sort()).toEqual(['pages/BlameView.module.css', 'pages/ConflictsPage.module.css', 'pages/HistoryPages.module.css', 'pages/InteractiveRebasePage.module.css', 'pages/MergeWindow.module.css'])
  })

  it('B1 styles do not use DSH tokens that are missing at runtime without a fallback', () => {
    const offending = uses
      .filter(use => GUARDED.test(use.file) && !use.fallback && use.name in MISSING_TOKENS)
      .map(use => `${use.file}: ${use.name} → use ${MISSING_TOKENS[use.name] ?? ''}`)
    expect(offending).toEqual([])
  })
})
