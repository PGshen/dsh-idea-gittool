// @vitest-environment happy-dom
// B4b T2: first DOM-level keyboard test — ↑↓ in the log grid moves aria-selected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogPage } from '../../../src/client/pages/LogPage.tsx'
import { createLogStore } from '../../../src/client/store/log-store.ts'
import type { LogStore } from '../../../src/client/store/log-store.ts'
import type { CommitSummary, LogValue, RpcResult } from '../../../src/shared/protocol.ts'
import { allByRole, byRole, focus, press, render, stubLayout } from '../dom.tsx'
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

function selectedSubjects(root: ParentNode): string[] {
  return allByRole(root, 'row').filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.textContent ?? '')
}

describe('log grid keyboard (DOM)', () => {
  it('ArrowDown and ArrowUp move the selected row', async () => {
    const store = await loadedStore(3)
    view = render(withLocale(<LogPage store={store} autoLoad={false} viewportHeight={520} />) as React.ReactElement)
    const grid = byRole(view.container, 'grid')
    focus(grid)
    press('ArrowDown', grid)
    expect(selectedSubjects(view.container).join()).toContain('subject 0')
    press('ArrowDown', grid)
    expect(selectedSubjects(view.container).join()).toContain('subject 1')
    press('ArrowUp', grid)
    expect(selectedSubjects(view.container).join()).toContain('subject 0')
  })
})
