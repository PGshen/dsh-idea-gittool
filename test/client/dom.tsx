/**
 * DOM test helpers (B4b T2, TD-18). Only `*.dom.test.tsx` files run under happy-dom, opted in with
 * a `// @vitest-environment happy-dom` docblock; every other test stays in the node environment.
 */
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

// React reads this global to silence act() warnings.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// happy-dom starts in quirks mode, which KaTeX (pulled in through ui-primitives) warns about.
if (document.doctype === null) document.insertBefore(document.implementation.createDocumentType('html', '', ''), document.documentElement)

/**
 * happy-dom does no layout, so every element measures 0×0 and virtual lists render no rows.
 * Give every element the same client box until the returned function restores the prototype.
 */
export function stubLayout(size: { width: number; height: number }): () => void {
  const proto = HTMLElement.prototype
  const saved = ['clientWidth', 'clientHeight'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => size.width })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => size.height })
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(proto, key)
      else Object.defineProperty(proto, key, descriptor)
    }
  }
}

export interface Rendered {
  container: HTMLElement
  rerender(ui: ReactElement): void
  unmount(): void
}

/** Mount `ui` into a fresh container attached to `document.body`. */
export function render(ui: ReactElement): Rendered {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    rerender(next) { act(() => { root.render(next) }) },
    unmount() {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Dispatch a bubbling keydown on `target` (defaults to the focused element). */
export function press(key: string, target: Element | null = document.activeElement, init: KeyboardEventInit = {}): void {
  if (target === null) throw new Error(`press(${key}): nothing is focused`)
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

export function click(target: Element): void {
  act(() => {
    if (target instanceof HTMLElement) target.click()
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A pointer-down (outside-click handlers listen for it in the capture phase). */
export function pointerDown(target: Element): void {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
}

export function focus(target: Element): void {
  act(() => { (target as HTMLElement).focus() })
}

function implicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a' && element.hasAttribute('href')) return 'link'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'text' || type === 'search') return 'textbox'
  }
  if (tag === 'select') return 'combobox'
  return null
}

export function roleOf(element: Element): string | null {
  return element.getAttribute('role') ?? implicitRole(element)
}

/** Accessible name, simplified: aria-labelledby > aria-label > text content (whitespace collapsed). */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    return labelledBy.split(/\s+/)
      .map(id => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ').replace(/\s+/g, ' ').trim()
  }
  const label = element.getAttribute('aria-label')
  if (label !== null) return label.trim()
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function allByRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('*')].filter(element => {
    if (roleOf(element) !== role) return false
    if (name === undefined) return true
    const actual = accessibleName(element)
    return typeof name === 'string' ? actual === name : name.test(actual)
  })
}

export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement {
  const found = allByRole(root, role, name)
  if (found.length !== 1) {
    throw new Error(`byRole(${role}${name === undefined ? '' : `, ${String(name)}`}): expected 1 match, found ${String(found.length)}`)
  }
  return found[0] as HTMLElement
}

const CONTROL_ROLES = new Set(['button', 'menuitem', 'tab', 'checkbox', 'switch', 'treeitem', 'option', 'link'])

/** Visible text of `element`, leaving out `aria-hidden` parts, whitespace collapsed. */
export function visibleText(element: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
    return [...node.childNodes].map(walk).join(' ')
  }
  return walk(element).replace(/\s+/g, ' ').trim()
}

const MEANINGFUL = /[\p{L}\p{N}]/u

/**
 * WCAG 2.5.3 label-in-name and 4.1.2 name audit for every control under `root`: a control with
 * meaningful visible text whose aria-label / aria-labelledby name does not contain that text, and a
 * control with no name at all (no text, label or title). Symbol-only text (⋯ ✕ ▾) needs no match.
 */
export function nameViolations(root: ParentNode): string[] {
  const problems: string[] = []
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    const role = roleOf(element)
    if (role === null || !CONTROL_ROLES.has(role)) continue
    const shown = visibleText(element)
    const name = accessibleName(element)
    // aria-labelledby pointing at the control's own visible label (MenuItemButton) already satisfies
    // label-in-name; an aria-label replaces the visible text and must contain it.
    const labelled = element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')
    const describe = `${role} "${shown || element.outerHTML.slice(0, 80)}"`
    if (name === '' && (element.getAttribute('title') ?? '') === '' && element.closest('label') === null) {
      problems.push(`${describe} has no accessible name`)
    } else if (labelled && MEANINGFUL.test(shown) && !name.toLowerCase().includes(shown.toLowerCase())) {
      problems.push(`${describe} is named "${name}" (does not contain its visible text)`)
    }
  }
  return problems
}
