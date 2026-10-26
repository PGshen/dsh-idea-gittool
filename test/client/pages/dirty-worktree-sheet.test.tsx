// A3 T6 DirtyWorktreeSheet: title, first 10 paths + total, "stash and continue" / "cancel", Esc cancels.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { en, zh } from '../../../src/client/locales.ts'
import { enT, zhT } from '../i18n-helpers.tsx'
import {
  DIRTY_VISIBLE_PATHS,
  DirtyWorktreeSheetView,
  handleDirtyEscape,
} from '../../../src/client/pages/DirtyWorktreeSheet.tsx'
import type { DirtyWorktreeSheetViewProps } from '../../../src/client/pages/DirtyWorktreeSheet.tsx'
import type { StashAsk } from '../../../src/client/store/action-store.ts'

interface AnyElement { type: unknown; props: Record<string, unknown> & { children?: unknown } }

function isElement(node: unknown): node is AnyElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node
}

function findAll(node: unknown, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate))
  if (!isElement(node)) return []
  const own = predicate(node) ? [node] : []
  return [...own, ...findAll(node.props.children, predicate)]
}

const paths = Array.from({ length: 12 }, (_, index) => `src/file-${index + 1}.ts`)

function ask(overrides: Partial<StashAsk> = {}): StashAsk {
  return { key: 'merge:x', endpoint: 'merge', operation: 'merge', paths, count: 37, ...overrides }
}

function props(overrides: Partial<DirtyWorktreeSheetViewProps> = {}): DirtyWorktreeSheetViewProps {
  return { t: zhT, ask: ask(), onStash: vi.fn(), onCancel: vi.fn(), ...overrides }
}

describe('DirtyWorktreeSheetView', () => {
  it('shows the title, the first 10 paths and the total, and both buttons', () => {
    const html = renderToStaticMarkup(<DirtyWorktreeSheetView {...props()} />)
    expect(DIRTY_VISIBLE_PATHS).toBe(10)
    expect(zh['dirty.title']).toBe('工作区有未提交改动')
    expect(zh['dirty.stash']).toBe('贮藏并继续')
    expect(html).toContain('工作区有未提交改动')
    expect(html).toContain('src/file-1.ts')
    expect(html).toContain('src/file-10.ts')
    expect(html).not.toContain('src/file-11.ts')
    expect(html).toContain(zh['dirty.count'].replace('{count}', '37'))
    expect(html).toContain(zh['dirty.more'].replace('{count}', '27'))
    expect(html).toContain('贮藏并继续')
    expect(html).toContain('取消')
    expect(html).toContain(zh['smart.operation.merge'])
  })

  it('no "more" line when every path is shown', () => {
    const html = renderToStaticMarkup(<DirtyWorktreeSheetView {...props({ ask: ask({ paths: ['a.ts'], count: 1 }) })} />)
    expect(html).not.toContain(zh['dirty.more'].replace('{count}', '0'))
    expect(html).not.toMatch(/data-dirty-more/)
  })

  it('renders in English', () => {
    const html = renderToStaticMarkup(<DirtyWorktreeSheetView {...props({ t: enT })} />)
    expect(html).toContain(en['dirty.title'])
    expect(html).toContain(en['dirty.stash'])
  })

  it('wires the buttons: stash is primary, cancel calls onCancel', () => {
    const onStash = vi.fn()
    const onCancel = vi.fn()
    const tree = DirtyWorktreeSheetView(props({ onStash, onCancel }))
    const primary = findAll(tree, element => element.props['data-primary'] !== undefined)[0]
    ;(primary?.props.onClick as () => void)()
    expect(onStash).toHaveBeenCalledTimes(1)
    const cancel = findAll(tree, element => element.props['data-cancel'] !== undefined)[0]
    ;(cancel?.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('handleDirtyEscape', () => {
  it('Esc cancels and stops the event; other keys do nothing', () => {
    const cancel = vi.fn()
    const event = { key: 'Escape', defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    handleDirtyEscape(event, cancel)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    handleDirtyEscape({ ...event, key: 'Enter' }, cancel)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
