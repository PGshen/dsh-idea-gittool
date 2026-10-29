// @vitest-environment happy-dom
// B2 final review minor: unmounting the workbench releases the file-history store it keeps above the overlay.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitClient } from '../../../src/client/git-client.ts'
import { I18nProvider } from '../../../src/client/i18n.tsx'
import type { BootstrapValue } from '../../../src/shared/protocol.ts'
import { render } from '../dom.tsx'
import { zhT } from '../i18n-helpers.tsx'

const closed = vi.hoisted(() => ({ count: 0 }))

vi.mock('../../../src/client/store/file-history-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/client/store/file-history-store.ts')>()
  return {
    ...actual,
    createFileHistoryStore: (...args: Parameters<typeof actual.createFileHistoryStore>) => {
      const store = actual.createFileHistoryStore(...args)
      const close = store.close.bind(store)
      store.close = () => {
        closed.count += 1
        close()
      }
      return store
    },
  }
})

const { GitWorkbench } = await import('../../../src/client/pages/GitWorkbench.tsx')

/** Every RPC stays pending: the test only needs the component tree mounted. */
const client = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as GitClient

const value: BootstrapValue = {
  sessionId: 's',
  repoRoot: null,
  status: null,
  writePolicy: { mode: 'read-only', reason: 'test' },
  version: 1,
}

afterEach(() => { closed.count = 0 })

describe('GitWorkbench unmount', () => {
  it('closes the file-history store', () => {
    const view = render(<I18nProvider t={zhT}>
      <GitWorkbench
        sessionId="s"
        client={client}
        value={value}
        onRefresh={async () => undefined}
        autoRefresh={false}
        onToggleAutoRefresh={() => undefined}
        lastRefreshAt={null}
      />
    </I18nProvider>)
    const before = closed.count
    view.unmount()
    expect(closed.count).toBeGreaterThan(before)
  })
})
