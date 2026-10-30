// @vitest-environment happy-dom
// t2 T2: the "not clean / three-way" bar and the delete confirmation belong to the entry they were
// raised for. A refresh that moves the selection to another entry hides them, and nothing they
// trigger can act on the newly selected entry.
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShelfPanel } from '../../../src/client/pages/ShelfPanel.tsx'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import { createShelfStore } from '../../../src/client/store/shelf-store.ts'
import type { RpcResult, ShelfEntry, ShelfListValue, ShelfPatchValue } from '../../../src/shared/protocol.ts'
import { allByRole, byRole, click, render, visibleText } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'

const entry = (id: string): ShelfEntry => ({
  id, name: `name ${id}`, createdAt: '2026-10-27T10:00:00.000Z', branch: 'main', baseSha: 'a'.repeat(40),
  files: [{ path: 'a.txt', status: 'M' }],
})

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
}

function setup(run: (method: string, request: unknown) => Promise<ActionOutcome<unknown>>) {
  let shelves: ShelfEntry[] = [entry('A'), entry('B')]
  const list = vi.fn(async (): Promise<RpcResult<ShelfListValue>> => ({ ok: true, value: { shelves } }))
  const patch = vi.fn(async (request: { id: string }): Promise<RpcResult<ShelfPatchValue>> => ({ ok: true, value: { patch: `patch ${request.id}` } }))
  const store = createShelfStore({ sessionId: 's', list, patch })
  const actions = { run: vi.fn(run) as unknown as Parameters<typeof ShelfPanel>[0]['actions']['run'] }
  const ui = (version: number): ReactElement => withLocale(
    <ShelfPanel store={store} actions={actions} busy={false} blockReason={null} version={version} onConflicts={() => {}} onApplied={() => {}} />,
  ) as ReactElement
  return {
    store,
    actions,
    ui,
    setShelves: (next: ShelfEntry[]) => { shelves = next },
  }
}

const conflict: ActionOutcome<unknown> = { kind: 'failed', error: { code: 'git/conflict', message: 'does not apply' }, message: { key: 'action.error.fallback' } as never }

describe('ShelfPanel: bars bound to an entry', () => {
  it('hides the three-way bar when a refresh moves the selection to another entry', async () => {
    const s = setup(async () => conflict)
    view = render(s.ui(1))
    await flush()
    expect(s.store.getState().selectedId).toBe('A')

    click(byRole(view.container, 'button', '取回'))
    await flush()
    expect(visibleText(view.container)).toContain('不能干净地应用到当前文件')

    s.setShelves([entry('B')])
    view.rerender(s.ui(2))
    await flush()

    expect(s.store.getState().selectedId).toBe('B')
    expect(visibleText(view.container)).not.toContain('不能干净地应用到当前文件')
    expect(allByRole(view.container, 'button', /三方合并应用/)).toHaveLength(0)
    expect(s.actions.run).not.toHaveBeenCalledWith('shelfApply', expect.objectContaining({ id: 'B' }), expect.anything())
  })

  it('a refused apply that returns after the selection moved raises no bar on the new entry', async () => {
    let release: (outcome: ActionOutcome<unknown>) => void = () => {}
    const s = setup(() => new Promise((resolve) => { release = resolve }))
    view = render(s.ui(1))
    await flush()
    click(byRole(view.container, 'button', '取回'))
    await flush()

    s.setShelves([entry('B')])
    view.rerender(s.ui(2))
    await flush()
    release(conflict)
    await flush()

    expect(s.store.getState().selectedId).toBe('B')
    expect(allByRole(view.container, 'button', /三方合并应用/)).toHaveLength(0)
  })

  it('hides the delete confirmation when a refresh moves the selection, so B cannot be deleted', async () => {
    const s = setup(async () => ({ kind: 'done', value: null }))
    view = render(s.ui(1))
    await flush()

    click(byRole(view.container, 'button', '删除…'))
    expect(visibleText(view.container)).toContain('删除搁架「name A」')

    s.setShelves([entry('B')])
    view.rerender(s.ui(2))
    await flush()

    expect(s.store.getState().selectedId).toBe('B')
    expect(visibleText(view.container)).not.toContain('删除搁架')
    expect(allByRole(view.container, 'button', '删除')).toHaveLength(0)
    expect(s.actions.run).not.toHaveBeenCalled()
  })

  it('deletes the entry the confirmation was raised for', async () => {
    const s = setup(async () => ({ kind: 'done', value: null }))
    view = render(s.ui(1))
    await flush()
    click(byRole(view.container, 'button', '删除…'))
    click(byRole(view.container, 'button', '删除'))
    await flush()
    expect(s.actions.run).toHaveBeenCalledWith('shelfDrop', { id: 'A' }, expect.anything())
  })
})

describe('createShelfStore: refresh ordering', () => {
  it('drops a refresh result that resolves after a newer one', async () => {
    const releases: ((value: RpcResult<ShelfListValue>) => void)[] = []
    const list = vi.fn(() => new Promise<RpcResult<ShelfListValue>>((resolve) => { releases.push(resolve) }))
    const patch = vi.fn(async (request: { id: string }): Promise<RpcResult<ShelfPatchValue>> => ({ ok: true, value: { patch: `patch ${request.id}` } }))
    const store = createShelfStore({ sessionId: 's', list, patch })

    const first = store.refresh()
    const second = store.refresh()
    releases[1]?.({ ok: true, value: { shelves: [entry('B')] } })
    await second
    releases[0]?.({ ok: true, value: { shelves: [entry('A'), entry('B')] } })
    await first

    expect(store.getState()).toMatchObject({ status: 'ready', selectedId: 'B', patch: 'patch B' })
    expect(store.getState().shelves.map(shelf => shelf.id)).toEqual(['B'])
  })

  it('drops a stale refresh failure', async () => {
    const releases: ((value: RpcResult<ShelfListValue>) => void)[] = []
    const list = vi.fn(() => new Promise<RpcResult<ShelfListValue>>((resolve) => { releases.push(resolve) }))
    const store = createShelfStore({ sessionId: 's', list, patch: async () => ({ ok: true, value: { patch: 'p' } }) })
    const first = store.refresh()
    const second = store.refresh()
    releases[1]?.({ ok: true, value: { shelves: [entry('B')] } })
    await second
    releases[0]?.({ ok: false, error: { code: 'git/exec-failed', message: 'old' } })
    await first
    expect(store.getState()).toMatchObject({ status: 'ready', error: null })
  })
})
