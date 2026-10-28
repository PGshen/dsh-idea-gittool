// B1 acceptance demo: the /dsh-git body limit is per endpoint. mergeApply / mergeDraftSave carry
// a whole merge result (up to 8 MiB before JSON escaping), every other endpoint stays at 256 KiB.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BODY_MAX_BYTES, MERGE_BODY_MAX_BYTES, bodyLimitFor, registerRpcRoutes } from '../../src/host/http.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

let server: Server
let baseUrl: string
let calls: Array<{ endpoint: string; size: number }>

beforeEach(async () => {
  calls = []
  let route: RouteHandler | undefined
  const webCtx = {
    webServer: { register: (r: { handler: RouteHandler }) => { route = r.handler; return () => {} } },
    effect: (fn: () => unknown) => { fn() },
  }
  const ctx = {
    connection: { requestRejection: () => undefined },
    inject: (_deps: string[], callback: (c: typeof webCtx) => void) => { callback(webCtx) },
  }
  registerRpcRoutes(ctx as unknown as Context, async (endpoint, payload) => {
    calls.push({ endpoint, size: JSON.stringify(payload).length })
    return { ok: true, value: { endpoint } }
  })
  server = createServer((req, res) => { void route?.(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-git`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function post(endpoint: string, body: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  return { status: response.status, json: await response.json() }
}

function mergeApplyBody(resultBytes: number): string {
  return JSON.stringify({ sessionId: 's', requestId: 'r', path: 'big.txt', result: 'x'.repeat(resultBytes), stages: { base: null, ours: null, theirs: null }, expectedWorktreeSha: null })
}

describe('registerRpcRoutes / per-endpoint body limit', () => {
  it('keeps 256 KiB for ordinary endpoints and allows a merge result plus escaping for the merge writes', () => {
    expect(DEFAULT_BODY_MAX_BYTES).toBe(256 * 1024)
    expect(bodyLimitFor('commitFiles')).toBe(DEFAULT_BODY_MAX_BYTES)
    expect(bodyLimitFor('mergeFile')).toBe(DEFAULT_BODY_MAX_BYTES)
    expect(bodyLimitFor('mergeApply')).toBe(MERGE_BODY_MAX_BYTES)
    expect(bodyLimitFor('mergeDraftSave')).toBe(MERGE_BODY_MAX_BYTES)
    // B3b: an 8 MiB patch plus JSON escaping (ADR 0009).
    expect(bodyLimitFor('applyPatch')).toBe(MERGE_BODY_MAX_BYTES)
    // An 8 MiB result whose every character escapes to two bytes still fits.
    expect(MERGE_BODY_MAX_BYTES).toBeGreaterThan(2 * 8 * 1024 * 1024)
  })

  it('accepts a ~2 MiB mergeApply body (the real-browser failure)', async () => {
    const response = await post('mergeApply', mergeApplyBody(2 * 1024 * 1024))
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ ok: true, value: { endpoint: 'mergeApply' } })
    expect(calls).toHaveLength(1)
  })

  it('accepts a ~2 MiB mergeDraftSave body', async () => {
    const body = JSON.stringify({ sessionId: 's', requestId: 'r', path: 'big.txt', draft: { version: 1, result: 'y'.repeat(2 * 1024 * 1024), chunks: [] } })
    const response = await post('mergeDraftSave', body)
    expect(response.status).toBe(200)
  })

  it('rejects a merge body over the merge limit with 413 and a structured body-too-large error', async () => {
    const response = await post('mergeApply', mergeApplyBody(MERGE_BODY_MAX_BYTES + 1))
    expect(response.status).toBe(413)
    expect(response.json).toMatchObject({ ok: false, error: { code: 'git/invalid-payload', details: { reason: 'body-too-large' } } })
    expect(calls).toHaveLength(0)
  })

  it('still rejects other endpoints over 256 KiB', async () => {
    const body = JSON.stringify({ sessionId: 's', requestId: 'r', message: 'm'.repeat(DEFAULT_BODY_MAX_BYTES), paths: [] })
    const response = await post('commitFiles', body)
    expect(response.status).toBe(413)
    expect(response.json).toMatchObject({ ok: false, error: { code: 'git/invalid-payload', details: { reason: 'body-too-large' } } })
    expect(calls).toHaveLength(0)
  })

  it('answers malformed JSON with 400 invalid-payload', async () => {
    const response = await post('status', '{nope')
    expect(response.status).toBe(400)
    expect(response.json).toMatchObject({ ok: false, error: { code: 'git/invalid-payload' } })
  })
})
