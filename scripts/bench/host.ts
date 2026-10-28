// B4c: Host latency benchmark (L5, not part of `make check`). Run with `pnpm bench`.
// Builds the 10k synthetic repository, then times each RPC endpoint through the real handler
// (real git via the test subprocess shim, no DSH, no HTTP). Every sample uses a fresh handler
// so nothing is served from the per-repository cache; repository resolution is warmed first.
// Prints a Markdown table, writes JSON to .evidence/b4c/, exits 1 when a budgeted item is over.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { createGitRunner } from '../../src/host/git-executor.ts'
import { createRpcHandler } from '../../src/host/rpc.ts'
import type { GitRpcHandler } from '../../src/host/rpc.ts'
import { createFakeSubprocess } from '../../test/host/fake-subprocess.ts'
import { createTempDir, removeTempDir, TEST_GIT_ENV } from '../../test/host/fixtures.ts'
import { createBenchRepo } from './fixture.mjs'

const SAMPLES = 7
const SESSION = 'bench'
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const SIGNAL = new AbortController().signal

interface Item {
  name: string
  endpoint: string
  payload: Record<string, unknown>
  /** §16.8 budget in ms; null = recorded only (explain when over 500ms). */
  budgetMs: number | null
  /** Warm-up endpoint called untimed on the fresh handler first. */
  warm?: string
  check?: (value: Record<string, unknown>) => string | undefined
  /** Reuse one handler and step its clock past the cache TTL each sample (the 3s poll). */
  steady?: boolean
}

interface Row {
  name: string
  endpoint: string
  medianMs: number
  p95Ms: number
  maxMs: number
  budgetMs: number | null
  bytes: number
  ok: boolean
  note: string
}

function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? Number.NaN
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

async function main(): Promise<void> {
  const commits = Number(process.env.BENCH_COMMITS ?? 10_000)
  const dir = createTempDir('dsh-git-bench-')
  try {
    const started = performance.now()
    const repo = await createBenchRepo(dir, { commits })
    console.error(`fixture: ${String(commits)} first-parent commits in ${String(Math.round(performance.now() - started))}ms at ${repo.root}`)

    // The Host only accepts hexadecimal shas for commit/diff; resolve revisions up front.
    const sha = (rev: string): string =>
      spawnSync('git', ['rev-parse', rev], { cwd: repo.root, env: TEST_GIT_ENV, encoding: 'utf8' }).stdout.trim()

    let clock = 0
    const fresh = (): GitRpcHandler =>
      createRpcHandler({
        now: () => clock,
        runner: createGitRunner(createFakeSubprocess()),
        sandboxPolicy: () => ({ workspaceRoot: repo.root, resolve: () => ({ mode: 'read-only', workspaceRoot: repo.root }) }),
      })

    const items: Item[] = [
      { name: 'bootstrap (steady 3s poll)', endpoint: 'bootstrap', payload: {}, budgetMs: 50, steady: true },
      { name: 'bootstrap (first, fresh handler)', endpoint: 'bootstrap', payload: {}, budgetMs: null, warm: 'refs' },
      { name: 'log first page (50)', endpoint: 'log', payload: {}, budgetMs: 500 },
      { name: 'log first page (200)', endpoint: 'log', payload: { limit: 200 }, budgetMs: 500 },
      { name: 'commit detail', endpoint: 'commit', payload: { sha: sha('HEAD') }, budgetMs: 200 },
      { name: 'commit detail (merge)', endpoint: 'commit', payload: { sha: repo.mergeSha }, budgetMs: 200 },
      { name: 'diff worktree file', endpoint: 'diff', payload: { path: repo.modified[0], scope: 'worktree' }, budgetMs: 300 },
      { name: 'diff 4500-line file (commit)', endpoint: 'diff', payload: { path: repo.bigFile, scope: 'commit', sha: sha('HEAD~500') }, budgetMs: 300 },
      {
        name: 'diff >256 KiB file (truncated)',
        endpoint: 'diff',
        payload: { path: repo.hugeFile, scope: 'commit', sha: repo.hugeDiffSha },
        budgetMs: 300,
        check: (value) => (value.truncated === true ? undefined : 'expected truncated'),
      },
      { name: 'branches', endpoint: 'branches', payload: {}, budgetMs: 100 },
      { name: 'blame 4500 lines (first page)', endpoint: 'blame', payload: { path: repo.bigFile, rev: 'HEAD' }, budgetMs: null },
      { name: 'file history first page', endpoint: 'fileHistory', payload: { path: repo.bigFile }, budgetMs: null },
      { name: 'compare topic-1 vs main', endpoint: 'compare', payload: { left: 'main', right: 'topic-1' }, budgetMs: null },
      {
        name: 'rebase plan (24 commits)',
        endpoint: 'rebasePlan',
        payload: { base: sha('HEAD~24') },
        budgetMs: null,
        check: (value) => (value.blocked === undefined ? undefined : `blocked: ${String(value.blocked)}`),
      },
      { name: 'stash list', endpoint: 'stashList', payload: {}, budgetMs: null },
      { name: 'search without match (scans 10k)', endpoint: 'log', payload: { query: 'zz-no-such-text' }, budgetMs: null },
    ]

    const rows: Row[] = []
    for (const item of items) {
      const times: number[] = []
      let bytes = 0
      let note = ''
      const shared = item.steady === true ? fresh() : undefined
      if (shared !== undefined) await shared(item.endpoint, { sessionId: SESSION, ...item.payload }, SIGNAL)
      for (let sample = 0; sample <= SAMPLES; sample += 1) {
        clock += 3_000
        const handler = shared ?? fresh()
        if (shared === undefined) await handler(item.warm ?? 'bootstrap', { sessionId: SESSION }, SIGNAL)
        const begin = performance.now()
        const result = await handler(item.endpoint, { sessionId: SESSION, ...item.payload }, SIGNAL)
        const elapsed = performance.now() - begin
        if (!result.ok) {
          note = `error ${result.error.code}: ${result.error.message}`
          break
        }
        bytes = Buffer.byteLength(JSON.stringify(result.value))
        note = item.check?.(result.value as Record<string, unknown>) ?? note
        // Sample 0 is the warm-up (cold OS caches); it is not counted.
        if (sample > 0) times.push(elapsed)
      }
      const sorted = [...times].sort((a, b) => a - b)
      const medianMs = round(quantile(sorted, 0.5))
      const p95Ms = round(quantile(sorted, 0.95))
      const maxMs = round(sorted.at(-1) ?? Number.NaN)
      if (bytes > RESPONSE_MAX_BYTES) note = `${note} response over 4 MiB`.trim()
      const overBudget = item.budgetMs !== null && !(medianMs <= item.budgetMs)
      const ok = note === '' && !overBudget && times.length === SAMPLES
      if (item.budgetMs === null && medianMs > 500) note = `${note} over 500ms: explain`.trim()
      rows.push({ name: item.name, endpoint: item.endpoint, medianMs, p95Ms, maxMs, budgetMs: item.budgetMs, bytes, ok, note })
    }

    const lines = [
      `| 项 | 端点 | 中位 ms | p95 ms | 最大 ms | 预算 ms | 响应字节 | 结论 |`,
      `|---|---|---|---|---|---|---|---|`,
      ...rows.map((row) =>
        `| ${row.name} | \`${row.endpoint}\` | ${String(row.medianMs)} | ${String(row.p95Ms)} | ${String(row.maxMs)} | ${row.budgetMs === null ? '—' : String(row.budgetMs)} | ${String(row.bytes)} | ${row.ok ? '通过' : '不通过'}${row.note === '' ? '' : `（${row.note}）`} |`),
    ]
    console.log(lines.join('\n'))

    mkdirSync('.evidence/b4c', { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    writeFileSync(`.evidence/b4c/bench-${stamp}.json`, JSON.stringify({ commits, samples: SAMPLES, rows }, null, 2))
    if (rows.some((row) => !row.ok)) process.exitCode = 1
  } finally {
    removeTempDir(dir)
  }
}

await main()
