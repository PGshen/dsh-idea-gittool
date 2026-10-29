// @vitest-environment happy-dom
// B4c T6: a scroll step or a selection change must not re-render every visible row. Measured in the
// log harness: unmemoized rows cost ~5ms per scroll step at 2000 rows. GraphCell renders once per
// LogRow render, so a counting stand-in shows how many rows React re-rendered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graphRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../src/client/graph/GraphCell.tsx', () => ({
  GraphCell: () => {
    graphRenders.count += 1
    return null
  },
}))

import { LogPage } from '../../../src/client/pages/LogPage.tsx'
import { createLogStore } from '../../../src/client/store/log-store.ts'
import type { LogStore } from '../../../src/client/store/log-store.ts'
import type { CommitSummary, LogValue, RpcResult } from '../../../src/shared/protocol.ts'
import { allByRole, click, render, stubLayout } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'

function commit(index: number): CommitSummary {
  return {
    sha: `s${String(index)}`.padEnd(40, '0'),
    shortSha: `s${String(index)}`,
    parents: [`s${String(index + 1)}`.padEnd(40, '0')],
    author: 'Alice',
    email: 'alice@example.com',
    date: '2026-10-24T10:00:00+08:00',
    subject: `subject ${String(index)}`,
  }
}

async function loadedStore(count: number): Promise<LogStore> {
  const value: LogValue = { commits: Array.from({ length: count }, (_, index) => commit(index)), truncated: false }
  const store = createLogStore({ sessionId: 's', loadPage: async (): Promise<RpcResult<LogValue>> => ({ ok: true, value }) })
  await store.loadFirstPage()
  return store
}

let view: Rendered | null = null
let restoreLayout: (() => void) | null = null
beforeEach(() => { restoreLayout = stubLayout({ width: 600, height: 520 }) })
afterEach(() => { view?.unmount(); view = null; restoreLayout?.() })

describe('log rows are memoized (B4c T6)', () => {
  it('selecting a row re-renders only the rows whose selection changed', async () => {
    const store = await loadedStore(12)
    view = render(withLocale(<LogPage store={store} autoLoad={false} viewportHeight={520} />) as React.ReactElement)
    const rows = allByRole(view.container, 'row')
    expect(rows.length).toBeGreaterThan(4)

    click(rows[1]!)
    graphRenders.count = 0
    click(rows[3]!)

    // Row 1 loses the selection, row 3 gains it (and becomes active); nothing else changed.
    expect(graphRenders.count).toBeLessThanOrEqual(2)
    expect(rows[3]!.getAttribute('aria-selected')).toBe('true')
  })

  it('a parent re-render with unchanged rows re-renders no row', async () => {
    const store = await loadedStore(12)
    const page = (): React.ReactElement => withLocale(<LogPage store={store} autoLoad={false} viewportHeight={520} />) as React.ReactElement
    view = render(page())
    graphRenders.count = 0

    view.rerender(page())

    expect(graphRenders.count).toBe(0)
  })
})
