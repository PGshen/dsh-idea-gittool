// Static rules for the client's CSS modules (B4b T1): only DSH tokens that exist at runtime, no
// literal colours, and every animated file honours `prefers-reduced-motion`.
import { DSH_TOKENS } from '../dsh-tokens'

/** Names that were used by mistake before B4b (checked in the DSH web GUI, 2026-10-27) → the real ones. */
export const TOKEN_HINTS: Readonly<Record<string, string>> = {
  '--dsw-alias-state-success': '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn': '--dsw-alias-state-warn-primary',
  '--dsw-font-mono': '--dsw-font-markdown-code-block-font-family',
  '--dsw-alias-interactive-bg-selected': '--dsw-alias-interactive-bg-active',
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every rule violation in one CSS module, as `file: message` lines. */
export function lintCss(file: string, source: string, tokens: ReadonlySet<string> = DSH_TOKENS): string[] {
  const css = stripComments(source)
  const problems: string[] = []
  for (const match of css.matchAll(/var\(\s*(--dsw-[\w-]+)\s*(,)?/g)) {
    const name = match[1] ?? ''
    if (match[2] === undefined && !tokens.has(name)) {
      const hint = TOKEN_HINTS[name]
      problems.push(`${file}: ${name} is not defined by DSH${hint === undefined ? '' : ` → use ${hint}`}`)
    }
  }
  for (const match of css.matchAll(/:[^;{}]*?(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\()/g)) {
    problems.push(`${file}: literal colour ${match[1] ?? ''} (use a DSH token)`)
  }
  if (/\b(animation|transition)\s*:/.test(css) && !/prefers-reduced-motion\s*:\s*(reduce|no-preference)/.test(css)) {
    problems.push(`${file}: animates without a prefers-reduced-motion rule`)
  }
  return problems
}
