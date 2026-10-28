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

export interface FocusExemption { file: string; selector: string; reason: string }

/**
 * Selectors allowed to remove the outline: each has another focus indicator, or is a container
 * that only receives programmatic focus (`tabIndex={-1}`). Everything else keeps DSH's global
 * `:focus-visible` ring (ui-theme `focus.css`: colour + 2px width, hidden for pointer input).
 */
export const FOCUS_EXEMPT: readonly FocusExemption[] = [
  { file: 'pages/BlameView.module.css', selector: '.root', reason: 'tabIndex=-1 overlay root' },
  { file: 'pages/BranchSheets.module.css', selector: '.sheet', reason: 'tabIndex=-1 dialog root' },
  { file: 'pages/CommitMenuSheets.module.css', selector: '.root', reason: 'tabIndex=-1 dialog root' },
  { file: 'pages/DiffViewer.module.css', selector: '.root', reason: 'tabIndex=-1 viewer root' },
  { file: 'pages/DirtyWorktreeSheet.module.css', selector: '.sheet', reason: 'tabIndex=-1 dialog root' },
  { file: 'pages/HistoryPages.module.css', selector: '.root', reason: 'tabIndex=-1 overlay root' },
  { file: 'pages/InteractiveRebasePage.module.css', selector: '.root', reason: 'tabIndex=-1 dialog root' },
  { file: 'pages/MergeWindow.module.css', selector: '.window', reason: 'tabIndex=-1 window root' },
  { file: 'pages/PushRejectedPage.module.css', selector: '.root', reason: 'tabIndex=-1 overlay root' },
  { file: 'pages/RemotesPages.module.css', selector: '.root', reason: 'tabIndex=-1 overlay root' },
  { file: 'pages/RollbackSheet.module.css', selector: '.sheet', reason: 'tabIndex=-1 dialog root' },
  { file: 'pages/InteractiveRebasePage.module.css', selector: '.list', reason: '.list:focus-visible .selected marks the focused row' },
  { file: 'pages/LogTable.module.css', selector: '.scroller', reason: '.scroller:focus-visible draws an inset brand ring' },
  { file: 'pages/MergeWindow.module.css', selector: '.editor:global(.cm-focused)', reason: 'text editor: the caret shows focus' },
  { file: 'pages/CommitMessage.module.css', selector: '.input:focus', reason: 'text input: brand border on focus' },
  { file: 'pages/FilterBar.module.css', selector: '.searchInput', reason: 'text input: .search:focus-within draws the ring' },
  { file: 'pages/FilterBar.module.css', selector: '.jump', reason: 'text input: brand border on .jump:focus' },
]

export const TEXT_TONE_HINT = 'color-mix(in oklab, var(<hue>) 60%, var(--dsw-alias-label-primary))'

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every rule violation in one CSS module, as `file: message` lines. */
export function lintCss(
  file: string,
  source: string,
  tokens: ReadonlySet<string> = DSH_TOKENS,
  focusExempt: readonly FocusExemption[] = FOCUS_EXEMPT,
): string[] {
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
  // B4b T8: pure success/warn (and the theme-independent static hues) are ~2.2:1 on the light theme's white; as text they are mixed toward
  // label-primary (design §15.3's lane recipe; 60% measures ≥5.3:1 light, ≥8:1 dark).
  for (const match of css.matchAll(/(?:^|[;{\s])color\s*:\s*var\(\s*(--dsw-alias-state-(?:success|warn)-primary|--dsw-static-[\w-]+)\s*\)/g)) {
    problems.push(`${file}: text colour ${match[1] ?? ''} is below 3:1 on light backgrounds (use ${TEXT_TONE_HINT})`)
  }
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    if (!/(^|;|\s)outline\s*:\s*(none|0)\b/.test(match[2] ?? '')) continue
    if (focusExempt.some(entry => entry.file === file && entry.selector === selector)) continue
    problems.push(`${file}: ${selector} removes the focus outline (keep DSH's :focus-visible ring or add it to FOCUS_EXEMPT with the replacement)`)
  }
  return problems
}
