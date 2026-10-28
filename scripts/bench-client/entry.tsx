// B4c: log-scroll render harness (L4 helper, not part of `make check`). Real LogPage + 2000
// synthetic rows (a merge every 7 commits). `pnpm bench:client` builds it into .evidence/b4c/harness;
// open index.html in a browser and run `await harness.measure()` in the console.
import { createRoot } from 'react-dom/client'

import { LogPage } from '../../src/client/pages/LogPage.tsx'
import { writeSettings } from '../../src/client/settings.ts'
import { createLogStore } from '../../src/client/store/log-store.ts'
import type { CommitSummary } from '../../src/shared/protocol.ts'

const hex = (value: number): string => value.toString(16).padStart(40, '0')

function commitAt(index: number): CommitSummary {
  const sha = hex(index)
  const parents = index % 7 === 0 ? [hex(index + 1), hex(index + 4)] : [hex(index + 1)]
  return {
    sha,
    shortSha: sha.slice(-7),
    parents,
    author: `Dev ${String(index % 5)}`,
    email: 'dev@example.com',
    date: new Date(Date.UTC(2026, 9, 25) - index * 60_000).toISOString(),
    subject: `commit #${String(index)} synthetic subject line for layout`,
  }
}

const store = createLogStore({
  sessionId: 'harness',
  pageSize: 200,
  loadPage: async (request) => {
    const offset = Number(request.cursor ?? 0)
    const commits = Array.from({ length: 200 }, (_, k) => commitAt(offset + k))
    return { ok: true, value: { commits, truncated: false, next: String(offset + 200) } }
  },
})

interface Measurement {
  compact: boolean
  rows: number
  steps: number
  medianMs: number
  p95Ms: number
  maxMs: number
  maxRowNodes: number
  /** Steps after which no rendered row covered the scrolled-to position (must be 0). */
  staleSteps: number
}

// Yield one macrotask so React commits the scroll update. MessageChannel, not setTimeout(0):
// nested timers are clamped to ≥4ms, which would dominate the measurement.
const channel = new MessageChannel()
const settle = (): Promise<void> => new Promise((resolve) => {
  channel.port1.onmessage = () => { resolve() }
  channel.port2.postMessage(null)
})

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN
}

/** Scroll the grid row by row-band to the bottom; each step times scroll → React commit → layout. */
async function measure(options: { compact?: boolean; steps?: number } = {}): Promise<Measurement> {
  const compact = options.compact ?? false
  writeSettings({ compact })
  await store.loadFirstPage()
  while (!store.getState().atRowLimit && store.getState().commits.length < 2000) await store.loadNextPage()
  await settle()
  // The grid element is the virtual scroller.
  const scroller = document.querySelector<HTMLElement>('[role="grid"]')
  if (scroller === null || scroller.scrollHeight <= scroller.clientHeight) throw new Error('log scroller not found')
  const rowHeight = scroller.scrollHeight / store.getState().commits.length
  scroller.scrollTop = 0
  await settle()
  const steps = options.steps ?? 300
  const stride = (scroller.scrollHeight - scroller.clientHeight) / steps
  const times: number[] = []
  let maxRowNodes = 0
  let staleSteps = 0
  for (let step = 1; step <= steps; step += 1) {
    const started = performance.now()
    scroller.scrollTop = stride * step
    scroller.dispatchEvent(new Event('scroll'))
    await settle()
    void scroller.offsetHeight
    times.push(performance.now() - started)
    const rendered = [...scroller.querySelectorAll('[role="row"][aria-rowindex]')].map((row) => Number(row.getAttribute('aria-rowindex')))
    const expected = Math.floor(scroller.scrollTop / rowHeight) + 1
    if (!rendered.some((index) => Math.abs(index - expected) <= 2)) staleSteps += 1
    maxRowNodes = Math.max(maxRowNodes, rendered.length)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    compact,
    rows: store.getState().commits.length,
    steps,
    medianMs: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? Number.NaN),
    maxRowNodes,
    staleSteps,
  }
}

Object.assign(window, { harness: { store, measure } })

const root = document.getElementById('log')
if (root !== null) createRoot(root).render(<LogPage store={store} autoLoad={false} viewportHeight={800} />)
