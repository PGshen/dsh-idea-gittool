// B1 acceptance demo: CSS that names a DSH variable which does not exist at runtime silently
// renders nothing (transparent chunk tones, default fonts). B4b widens the guard to every CSS
// module and checks names against a snapshot of what DSH ui-theme actually defines.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DSH_TOKENS } from '../dsh-tokens'
import { FOCUS_EXEMPT, TEXT_TONE_HINT, lintCss } from './css-lint'

const CLIENT_ROOT = join(import.meta.dirname, '../../../src/client')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.module.css') ? [path] : []
  })
}

const files = cssFiles(CLIENT_ROOT).map(path => ({
  file: relative(CLIENT_ROOT, path).split('\\').join('/'),
  css: readFileSync(path, 'utf8'),
}))

describe('CSS lint rules', () => {
  it('reports an unknown token with its hint, a literal colour and an animation without reduced motion', () => {
    const css = [
      '.a { color: var(--dsw-nope); background: var(--dsw-alias-state-success); }',
      '.b { border-color: #fff; }',
      '/* #abc in a comment is fine */',
      '.c { animation: spin 1s; color: var(--dsw-unknown, red); }',
    ].join('\n')
    expect(lintCss('x.module.css', css, new Set(['--dsw-alias-bg-base']))).toEqual([
      'x.module.css: --dsw-nope is not defined by DSH',
      'x.module.css: --dsw-alias-state-success is not defined by DSH → use --dsw-alias-state-success-primary',
      'x.module.css: literal colour #fff (use a DSH token)',
      'x.module.css: animates without a prefers-reduced-motion rule',
    ])
  })

  it('accepts an animation guarded by prefers-reduced-motion', () => {
    const css = '.a { transition: opacity 120ms; }\n@media (prefers-reduced-motion: reduce) { .a { transition: none; } }'
    expect(lintCss('y.module.css', css, new Set())).toEqual([])
    const opted = '@media (prefers-reduced-motion: no-preference) { .a { animation: pulse 1s; } }'
    expect(lintCss('z.module.css', opted, new Set())).toEqual([])
  })
})

describe('state colour text rule', () => {
  it('flags success/warn used directly as a text colour, not as a border or inside color-mix', () => {
    const css = [
      '.a { color: var(--dsw-alias-state-warn-primary); }',
      '.b { border-left: 2px solid var(--dsw-alias-state-warn-primary); background-color: var(--dsw-alias-state-success-primary); }',
      '.c { color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 60%, var(--dsw-alias-label-primary)); }',
      '.d { color: var(--dsw-alias-state-error-primary); }',
    ].join('\n')
    expect(lintCss('s.module.css', css, new Set(['--dsw-alias-state-warn-primary', '--dsw-alias-state-success-primary', '--dsw-alias-label-primary', '--dsw-alias-state-error-primary']), [])).toEqual([
      `s.module.css: text colour --dsw-alias-state-warn-primary is below 3:1 on light backgrounds (use ${TEXT_TONE_HINT})`,
    ])
  })
})

describe('focus outline rule', () => {
  it('flags outline: none unless the selector is exempt', () => {
    const css = '.row:hover, .row:focus-visible { outline: none; }\n.root { outline: 0; }\n.ok:focus-visible { outline-offset: -2px; }'
    expect(lintCss('f.module.css', css, new Set(), [{ file: 'f.module.css', selector: '.root', reason: 'tabIndex=-1' }])).toEqual([
      "f.module.css: .row:hover, .row:focus-visible removes the focus outline (keep DSH's :focus-visible ring or add it to FOCUS_EXEMPT with the replacement)",
    ])
  })

  it('every exemption still matches a rule (no stale entries)', () => {
    const stale = FOCUS_EXEMPT.filter(entry => {
      const css = files.find(item => item.file === entry.file)?.css ?? ''
      return !lintCss(entry.file, css, DSH_TOKENS, []).some(problem => problem.startsWith(`${entry.file}: ${entry.selector} removes`))
    })
    expect(stale).toEqual([])
  })
})

describe('client CSS modules', () => {
  it('scans every CSS module under src/client', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(DSH_TOKENS.has('--dsw-alias-bg-base')).toBe(true)
  })

  it('only use DSH tokens that exist, no literal colours, and honour reduced motion', () => {
    expect(files.flatMap(({ file, css }) => lintCss(file, css))).toEqual([])
  })
})
