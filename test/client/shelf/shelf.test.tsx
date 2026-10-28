// B3c T3: shelf UI — store (list, selection, patch, stale responses), panel and sheet views, menu paths.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ShelfPanelView, ShelveSheetView, defaultShelfName, shelvePaths } from '../../../src/client/pages/ShelfPanel.tsx'
import { createShelfStore } from '../../../src/client/store/shelf-store.ts'
import type { RpcResult, ShelfEntry, ShelfListValue, ShelfPatchValue } from '../../../src/shared/protocol.ts'
import { withLocale, zhT } from '../i18n-helpers.tsx'

const entry = (id: string, extra: Partial<ShelfEntry> = {}): ShelfEntry => ({
  id, name: `name ${id}`, createdAt: '2026-10-27T10:00:00.000Z', branch: 'main', baseSha: 'a'.repeat(40),
  files: [{ path: 'a.txt', status: 'M' }, { path: 'new.txt', status: '?' }], ...extra,
})
const noop = (): void => {}

describe('createShelfStore', () => {
  it('loads the list, selects the first entry and loads its patch', async () => {
    const list = vi.fn(async (): Promise<RpcResult<ShelfListValue>> => ({ ok: true, value: { shelves: [entry('b'), entry('a')] } }))
    const patch = vi.fn(async (request: { id: string }): Promise<RpcResult<ShelfPatchValue>> => ({ ok: true, value: { patch: `patch ${request.id}` } }))
    const store = createShelfStore({ sessionId: 's', list, patch })
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: 'ready', selectedId: 'b', patch: 'patch b' })
    await store.select('a')
    expect(store.getState()).toMatchObject({ selectedId: 'a', patch: 'patch a' })
  })

  it('drops a stale patch response and keeps the selection across refreshes when it still exists', async () => {
    let release: (value: RpcResult<ShelfPatchValue>) => void = () => {}
    const slow = new Promise<RpcResult<ShelfPatchValue>>((resolve) => { release = resolve })
    const patch = vi.fn()
      .mockReturnValueOnce(Promise.resolve({ ok: true, value: { patch: 'first' } }))
      .mockReturnValueOnce(slow)
      .mockReturnValue(Promise.resolve({ ok: true, value: { patch: 'third' } }))
    const store = createShelfStore({ sessionId: 's', list: async () => ({ ok: true, value: { shelves: [entry('b'), entry('a')] } }), patch })
    await store.refresh()
    const pending = store.select('a')
    await store.select('b')
    release({ ok: true, value: { patch: 'stale a' } })
    await pending
    expect(store.getState()).toMatchObject({ selectedId: 'b', patch: 'third' })
  })
})

describe('ShelfPanelView', () => {
  it('lists entries with name, branch and file count, previews the patch and offers the actions', () => {
    const html = renderToStaticMarkup(withLocale(
      <ShelfPanelView t={zhT} state={{ status: 'ready', shelves: [entry('a')], selectedId: 'a', patch: 'diff --git a/a.txt b/a.txt', patchError: null, error: null }} now={Date.parse('2026-10-27T12:00:00Z')} busy={false} blockReason={null} notClean={false} confirmingDrop={false} onSelect={noop} onApply={noop} onApplyThreeWay={noop} onAskDrop={noop} onCancelDrop={noop} onDrop={noop} onRetry={noop} />,
    ))
    expect(html).toContain('name a')
    expect(html).toContain('main · 2 个文件')
    expect(html).toContain('diff --git a/a.txt b/a.txt')
    expect(html).toContain('取回')
    expect(html).toContain('取回并保留')
    expect(html).toContain('删除…')
  })

  it('explains an empty shelf and offers a three-way apply after a refused one', () => {
    expect(renderToStaticMarkup(withLocale(
      <ShelfPanelView t={zhT} state={{ status: 'ready', shelves: [], selectedId: null, patch: null, patchError: null, error: null }} now={0} busy={false} blockReason={null} notClean={false} confirmingDrop={false} onSelect={noop} onApply={noop} onApplyThreeWay={noop} onAskDrop={noop} onCancelDrop={noop} onDrop={noop} onRetry={noop} />,
    ))).toContain('还没有搁置的改动')
    const refused = renderToStaticMarkup(withLocale(
      <ShelfPanelView t={zhT} state={{ status: 'ready', shelves: [entry('a')], selectedId: 'a', patch: 'x', patchError: null, error: null }} now={0} busy={false} blockReason={null} notClean confirmingDrop={false} onSelect={noop} onApply={noop} onApplyThreeWay={noop} onAskDrop={noop} onCancelDrop={noop} onDrop={noop} onRetry={noop} />,
    ))
    expect(refused).toContain('不能干净地应用到当前文件')
    expect(refused).toContain('三方合并应用')
  })
})

describe('ShelveSheetView and helpers', () => {
  it('names the entry and lists the files', () => {
    const html = renderToStaticMarkup(withLocale(<ShelveSheetView t={zhT} name="调试" paths={['a.txt', 'b.txt']} busy={false} error={null} onName={noop} onSubmit={noop} onCancel={noop} />))
    expect(html).toContain('搁置改动')
    expect(html).toContain('将搁置 2 个文件')
    expect(html).toContain('a.txt')
  })

  it('shelves the checked files when the row is checked, otherwise only that row', () => {
    expect(shelvePaths('a.txt', new Set(['a.txt', 'b.txt']))).toEqual(['a.txt', 'b.txt'])
    expect(shelvePaths('c.txt', new Set(['a.txt']))).toEqual(['c.txt'])
    expect(defaultShelfName(zhT, new Date('2026-10-27T09:05:00'))).toBe('搁置于 10-27 09:05')
  })
})

describe('ChangeContextMenu shelve item (B3c)', () => {
  it('appears only when the workbench wires it, and is disabled for conflicts', async () => {
    const { ChangeContextMenu } = await import('../../../src/client/pages/ChangesTree.tsx')
    const entry = { path: 'a.txt', status: 'M' as const, group: 'modified' as const }
    const without = renderToStaticMarkup(withLocale(<ChangeContextMenu entry={entry as never} writeDisabled={false} onCopyPath={noop} />))
    expect(without).not.toContain('data-menu="shelve"')
    const withItem = renderToStaticMarkup(withLocale(<ChangeContextMenu entry={entry as never} writeDisabled={false} onCopyPath={noop} onShelve={noop} />))
    expect(withItem).toMatch(/data-menu="shelve"[^>]*>搁置…/)
    const conflict = renderToStaticMarkup(withLocale(<ChangeContextMenu entry={{ ...entry, group: 'conflicts' } as never} writeDisabled={false} onCopyPath={noop} onShelve={noop} />))
    expect(conflict).toMatch(/disabled=""[^>]*data-menu="shelve"/)
  })
})
