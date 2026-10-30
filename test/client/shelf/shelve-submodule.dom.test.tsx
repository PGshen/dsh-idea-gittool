// @vitest-environment happy-dom
// t2 T3: submodules cannot be shelved. The sheet greys out rows it knows are submodules (an embedded
// repository shows as `dir/`; a gitlink is learned from the Host's `reason: 'submodule'` refusal),
// explains why, and shelves only the other files.
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShelveSheet, ShelveSheetView, submodulePathsOf } from '../../../src/client/pages/ShelfPanel.tsx'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import { actionErrorText } from '../../../src/client/store/action-store.ts'
import { byRole, click, render, visibleText } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { enT, withLocale, zhT } from '../i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
}

const refused = (paths: string[]): ActionOutcome<unknown> => {
  const error = { code: 'git/invalid-payload' as const, message: 'submodule', details: { reason: 'submodule', path: paths[0], paths } }
  return { kind: 'failed', error, message: actionErrorText(error) }
}

describe('submodule rows in the shelve sheet', () => {
  it('maps reason submodule to an explanation in both languages', () => {
    const error = { code: 'git/invalid-payload' as const, message: 'x', details: { reason: 'submodule', paths: ['sub'] } }
    expect(actionErrorText(error)).toEqual({ key: 'shelf.error.submodule' })
    expect(zhT('shelf.error.submodule')).toContain('子模块')
    expect(enT('shelf.error.submodule')).toContain('Submodule')
    expect(submodulePathsOf(error)).toEqual(['sub'])
    expect(submodulePathsOf({ code: 'git/invalid-payload', message: 'x', details: { reason: 'conflict' } })).toEqual([])
  })

  it('greys out a submodule row with the reason and counts only the other files', () => {
    view = render(withLocale(
      <ShelveSheetView t={zhT} name="x" paths={['a.txt', 'sub']} submodules={new Set(['sub'])} busy={false} error={null} onName={() => {}} onSubmit={() => {}} onCancel={() => {}} />,
    ) as ReactElement)
    const row = view.container.querySelector('[data-shelve-path="sub"]')
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    expect(visibleText(row!)).toContain('子模块，不能搁置')
    expect(visibleText(view.container)).toContain('将搁置 1 个文件')
  })

  it('cannot submit when every row is a submodule', () => {
    view = render(withLocale(
      <ShelveSheetView t={zhT} name="x" paths={['nested/']} submodules={new Set(['nested/'])} busy={false} error={null} onName={() => {}} onSubmit={() => {}} onCancel={() => {}} />,
    ) as ReactElement)
    expect((byRole(view.container, 'button', '搁置') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves an embedded repository (dir/) out from the start', async () => {
    const run = vi.fn(async (): Promise<ActionOutcome<unknown>> => ({ kind: 'done', value: {} }))
    view = render(withLocale(<ShelveSheet paths={['a.txt', 'nested/']} actions={{ run: run as never }} onShelved={() => {}} onClose={() => {}} />) as ReactElement)
    expect(view.container.querySelector('[data-shelve-path="nested/"]')?.getAttribute('aria-disabled')).toBe('true')
    click(byRole(view.container, 'button', '搁置'))
    await flush()
    expect(run).toHaveBeenCalledWith('shelfCreate', expect.objectContaining({ paths: ['a.txt'] }), expect.anything())
  })

  it('learns gitlinks from the Host refusal, explains it and shelves the rest on the next submit', async () => {
    const run = vi.fn<(method: string, request: { paths: string[] }) => Promise<ActionOutcome<unknown>>>()
      .mockResolvedValueOnce(refused(['sub']))
      .mockResolvedValue({ kind: 'done', value: {} })
    const onShelved = vi.fn()
    view = render(withLocale(<ShelveSheet paths={['a.txt', 'sub']} actions={{ run: run as never }} onShelved={onShelved} onClose={() => {}} />) as ReactElement)
    click(byRole(view.container, 'button', '搁置'))
    await flush()

    expect(run.mock.calls[0]?.[1].paths).toEqual(['a.txt', 'sub'])
    expect(visibleText(view.container)).toContain('子模块不能搁置')
    expect(view.container.querySelector('[data-shelve-path="sub"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(onShelved).not.toHaveBeenCalled()

    click(byRole(view.container, 'button', '搁置'))
    await flush()
    expect(run.mock.calls[1]?.[1].paths).toEqual(['a.txt'])
    expect(onShelved).toHaveBeenCalledOnce()
  })
})
