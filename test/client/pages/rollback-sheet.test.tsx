/**
 * T6 rollback sheet: object list and counts, danger confirmation text for untracked files,
 * cancel without side effects, result notes (kept staged / skipped), outcome and Esc dispatch.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RollbackValue } from '../../../src/shared/protocol.ts'
import type { RollbackState, RollbackTarget } from '../../../src/client/store/push-store.ts'
import {
  handleRollbackEscape,
  handleRollbackOutcome,
  ROLLBACK_VISIBLE_ROWS,
  RollbackSheet,
  RollbackSheetView,
  TEXT,
} from '../../../src/client/pages/RollbackSheet.tsx'
import type { RollbackSheetViewProps } from '../../../src/client/pages/RollbackSheet.tsx'

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

function invoke(element: AnyElement | undefined, name: string, ...args: unknown[]): void {
  const handler = element?.props[name]
  if (typeof handler !== 'function') throw new Error(`element has no ${name}`)
  ;(handler as (...values: unknown[]) => void)(...args)
}

const TARGETS: RollbackTarget[] = [
  { path: 'src/a.ts', untracked: false },
  { path: 'src/b.ts', untracked: false },
  { path: 'src/c.ts', untracked: false },
  { path: 'notes/new 1.md', untracked: true },
  { path: 'notes/new-2.md', untracked: true },
]

const IDLE: RollbackState = { deleteConfirmed: false, busy: false, error: null, result: null }

function props(overrides: Partial<RollbackSheetViewProps> = {}): RollbackSheetViewProps {
  return {
    targets: TARGETS,
    state: IDLE,
    readOnlyReason: null,
    onCancel: vi.fn(),
    onDeleteConfirmedChange: vi.fn(),
    onSubmit: vi.fn(),
    onCopy: vi.fn(),
    ...overrides,
  }
}

const primaryOf = (tree: unknown): AnyElement | undefined => findAll(tree, element => element.props['data-primary'] !== undefined)[0]
const formOf = (tree: unknown): AnyElement | undefined => findAll(tree, element => element.type === 'form')[0]

describe('RollbackSheetView', () => {
  it('lists every object with counts, the tracked impact and the untracked danger confirmation', () => {
    const html = renderToStaticMarkup(<RollbackSheetView {...props()} />)
    expect(html).toContain('回滚 5 个文件')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('notes/new 1.md')
    expect(html).toContain('data-untracked="true"')
    expect(html).toContain('将丢弃 3 个文件的未提交改动，且无法恢复。暂存区里的内容会保留。')
    expect(html).toContain('删除 2 个未跟踪文件且无法恢复')
    expect(html).toContain(TEXT.untrackedSkipHint)
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""/)
  })

  it('no untracked files → no danger confirmation', () => {
    const html = renderToStaticMarkup(<RollbackSheetView {...props({ targets: TARGETS.slice(0, 2) })} />)
    expect(html).not.toContain('data-untracked-confirm')
    expect(html).toContain('将丢弃 2 个文件')
  })

  it('ticking the danger confirmation reports it', () => {
    const p = props()
    const checkbox = findAll(RollbackSheetView(p), element => element.type === 'input' && element.props.type === 'checkbox')[0]
    invoke(checkbox, 'onChange', { currentTarget: { checked: true } })
    expect(p.onDeleteConfirmedChange).toHaveBeenCalledWith(true)
  })

  it('cancel calls onCancel only (no submit)', () => {
    const p = props()
    const cancel = findAll(RollbackSheetView(p), element => element.props.children === TEXT.cancel)[0]
    invoke(cancel, 'onClick')
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    expect(p.onSubmit).not.toHaveBeenCalled()
  })

  it('submit goes through the form; danger tone', () => {
    const p = props()
    const tree = RollbackSheetView(p)
    expect(primaryOf(tree)?.props.tone).toBe('danger')
    invoke(formOf(tree), 'onSubmit', { preventDefault: vi.fn() })
    expect(p.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('only untracked targets: blocked until the danger tick', () => {
    const onlyNew = TARGETS.filter(target => target.untracked)
    const p = props({ targets: onlyNew })
    const tree = RollbackSheetView(p)
    expect(primaryOf(tree)?.props.disabled).toBe(true)
    expect(renderToStaticMarkup(<RollbackSheetView {...p} />)).toContain(TEXT.block.nothing)
    invoke(formOf(tree), 'onSubmit', { preventDefault: vi.fn() })
    expect(p.onSubmit).not.toHaveBeenCalled()
    expect(primaryOf(RollbackSheetView(props({ targets: onlyNew, state: { ...IDLE, deleteConfirmed: true } })))?.props.disabled).toBe(false)
  })

  it('busy: loading label, buttons disabled', () => {
    const p = props({ state: { ...IDLE, busy: true } })
    const tree = RollbackSheetView(p)
    expect(primaryOf(tree)?.props.disabled).toBe(true)
    expect(renderToStaticMarkup(<RollbackSheetView {...p} />)).toContain(TEXT.submitting)
  })

  it('read-only disables with the reason', () => {
    const p = props({ readOnlyReason: '沙箱外' })
    expect(primaryOf(RollbackSheetView(p))?.props.disabled).toBe(true)
    expect(renderToStaticMarkup(<RollbackSheetView {...p} />)).toContain('只读模式：沙箱外')
  })

  it('shows kept-staged and skipped results', () => {
    const result: RollbackValue = { restored: ['src/a.ts'], deleted: [], keptStaged: ['src/b.ts'], skipped: ['notes/new 1.md', 'notes/new-2.md'] }
    const html = renderToStaticMarkup(<RollbackSheetView {...props({ state: { ...IDLE, result } })} />)
    expect(html).toContain('已丢弃 1 个文件的工作区改动')
    expect(html).toContain('暂存区改动已保留（1 个文件）')
    expect(html).toContain('已跳过 2 个未跟踪文件')
    expect(html).toContain(TEXT.close)
    expect(html).not.toContain('<form')
  })

  it('collapses long lists', () => {
    const many = Array.from({ length: ROLLBACK_VISIBLE_ROWS + 3 }, (_, index) => ({ path: `f${index}.ts`, untracked: false }))
    expect(renderToStaticMarkup(<RollbackSheetView {...props({ targets: many })} />)).toContain('还有 3 个文件')
  })

  it('renders a write error', () => {
    const html = renderToStaticMarkup(<RollbackSheetView {...props({ state: { ...IDLE, error: { code: 'git/locked', message: 'index.lock' } } })} />)
    expect(html).toContain('data-error-code="git/locked"')
  })
})

describe('handleRollbackOutcome', () => {
  it('reports and closes when nothing needs attention', () => {
    const callbacks = { onDone: vi.fn(), onClose: vi.fn() }
    handleRollbackOutcome({ kind: 'done', value: { restored: ['a'], deleted: [], keptStaged: [], skipped: [] } }, callbacks)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the sheet open for kept-staged / skipped notes', () => {
    const callbacks = { onDone: vi.fn(), onClose: vi.fn() }
    handleRollbackOutcome({ kind: 'done', value: { restored: [], deleted: [], keptStaged: ['b'], skipped: [] } }, callbacks)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onClose).not.toHaveBeenCalled()
  })

  it('failure and blocked do nothing', () => {
    const callbacks = { onDone: vi.fn(), onClose: vi.fn() }
    handleRollbackOutcome({ kind: 'failed', error: { code: 'git/locked', message: '' } }, callbacks)
    handleRollbackOutcome({ kind: 'blocked' }, callbacks)
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
  })
})

describe('handleRollbackEscape', () => {
  const keyEvent = (key: string) => ({ key, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() })

  it('closes when idle and stops propagation (only one level)', () => {
    const close = vi.fn()
    const event = keyEvent('Escape')
    handleRollbackEscape(event, { busy: false }, close)
    expect(close).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalled()
  })

  it('ignores Esc while busy and other keys', () => {
    const close = vi.fn()
    handleRollbackEscape(keyEvent('Escape'), { busy: true }, close)
    handleRollbackEscape(keyEvent('a'), { busy: false }, close)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('RollbackSheet container (first render)', () => {
  it('renders the confirmation without calling rollback', () => {
    const client = { rollback: vi.fn() }
    const html = renderToStaticMarkup(
      <RollbackSheet sessionId="s1" targets={TARGETS} client={client} onClose={vi.fn()} onDone={vi.fn()} />,
    )
    expect(html).toContain('删除 2 个未跟踪文件且无法恢复')
    expect(client.rollback).not.toHaveBeenCalled()
  })
})
