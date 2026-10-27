// A3 T6 GitClient: a typed method for every endpoint, each posting to its own /dsh-git path.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitClient } from '../../src/client/git-client.ts'
import { RPC_ENDPOINTS } from '../../src/shared/protocol.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('createGitClient', () => {
  it('has a method for every registered endpoint', () => {
    const client = createGitClient(undefined) as unknown as Record<string, unknown>
    for (const endpoint of RPC_ENDPOINTS) expect(typeof client[endpoint], endpoint).toBe('function')
  })

  it('A3 methods post their payload to the endpoint path', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { head: 'h', committed: true } })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)

    const merge = await client.merge({ sessionId: 's', requestId: 'r', ref: 'main', stash: true })
    expect(merge).toEqual({ ok: true, value: { head: 'h', committed: true } })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/merge', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 's', requestId: 'r', ref: 'main', stash: true }),
    }))

    await client.operationState('s')
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/operationState', expect.objectContaining({ body: JSON.stringify({ sessionId: 's' }) }))
    await client.stashList('s')
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/stashList', expect.objectContaining({ body: JSON.stringify({ sessionId: 's' }) }))
    await client.conflictCommand('s')
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/conflictCommand', expect.anything())
    await client.resetPreview({ sessionId: 's', sha: 'x' })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/resetPreview', expect.objectContaining({ body: JSON.stringify({ sessionId: 's', sha: 'x' }) }))
    await client.stashDrop({ sessionId: 's', requestId: 'r', sha: 'x' })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/stashDrop', expect.anything())
  })
})

describe('createGitClient / B1 merge endpoints', () => {
  it('posts mergeFile and the three merge writes to their endpoint paths', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { path: 'a.txt' } })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)
    const stages = { base: null, ours: 'o'.repeat(40), theirs: 't'.repeat(40) }

    await client.mergeFile({ sessionId: 's', path: 'a.txt' })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/mergeFile', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', path: 'a.txt' }),
    }))
    const draft = { version: 1 as const, stages, result: 'x\n', chunks: [{ state: 'pending' as const, leftDone: false, rightDone: false }], savedAt: '2026-10-26T00:00:00.000Z' }
    await client.mergeDraftSave({ sessionId: 's', requestId: 'r', path: 'a.txt', draft })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/mergeDraftSave', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', requestId: 'r', path: 'a.txt', draft }),
    }))
    await client.mergeApply({ sessionId: 's', requestId: 'r', path: 'a.txt', result: 'x\n', stages, expectedWorktreeSha: null })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/mergeApply', expect.anything())
    await client.unresolveConflict({ sessionId: 's', requestId: 'r', path: 'a.txt' })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/unresolveConflict', expect.anything())
  })
})

describe('createGitClient / non-2xx responses (B1 acceptance demo)', () => {
  it('surfaces the structured error body of a non-2xx response instead of "HTTP <status>"', async () => {
    const error = { code: 'git/invalid-payload', message: 'request body too large', details: { reason: 'body-too-large', limit: 1 } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error }), { status: 413 })))
    const client = createGitClient(undefined)
    const result = await client.mergeApply({ sessionId: 's', requestId: 'r', path: 'a.txt', result: 'x', stages: { base: null, ours: null, theirs: null }, expectedWorktreeSha: null })
    expect(result).toEqual({ ok: false, error })
  })

  it('keeps the HTTP status message when the non-2xx body is not the protocol envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const result = await createGitClient(undefined).status('s')
    expect(result).toEqual({ ok: false, error: { code: 'git/exec-failed', message: 'HTTP 401: status' } })
  })

  it('never turns a non-2xx response into success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: 1 }), { status: 500 })))
    const result = await createGitClient(undefined).status('s')
    expect(result).toEqual({ ok: false, error: { code: 'git/exec-failed', message: 'HTTP 500: status' } })
  })
})

describe('createGitClient / B3b endpoints', () => {
  it('sends the push-up-to revision with the preview only when given', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)
    await client.pushPreview('s')
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/pushPreview', expect.objectContaining({ body: JSON.stringify({ sessionId: 's' }) }))
    await client.pushPreview('s', undefined, 'c'.repeat(40))
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/pushPreview', expect.objectContaining({ body: JSON.stringify({ sessionId: 's', revision: 'c'.repeat(40) }) }))
  })

  it('posts formatPatch, createTag, fixupCommit and applyPatch to their endpoint paths', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)
    const sha = 'a'.repeat(40)
    const cases: Array<[string, () => Promise<unknown>, unknown]> = [
      ['formatPatch', () => client.formatPatch({ sessionId: 's', shas: [sha] }), { sessionId: 's', shas: [sha] }],
      ['createTag', () => client.createTag({ sessionId: 's', requestId: 'r', name: 'v1', target: sha, message: 'm' }), { sessionId: 's', requestId: 'r', name: 'v1', target: sha, message: 'm' }],
      ['fixupCommit', () => client.fixupCommit({ sessionId: 's', requestId: 'r', target: sha, paths: ['a'], kind: 'fixup' }), { sessionId: 's', requestId: 'r', target: sha, paths: ['a'], kind: 'fixup' }],
      ['applyPatch', () => client.applyPatch({ sessionId: 's', requestId: 'r', patch: 'diff', check: true }), { sessionId: 's', requestId: 'r', patch: 'diff', check: true }],
    ]
    for (const [endpoint, send, body] of cases) {
      await send()
      expect(fetch).toHaveBeenLastCalledWith(`dsh-git/${endpoint}`, expect.objectContaining({ body: JSON.stringify(body) }))
    }
  })
})

describe('createGitClient / B3a interactive rebase endpoints', () => {
  it('posts rebasePlan and interactiveRebase to their endpoint paths', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)

    await client.rebasePlan({ sessionId: 's', base: null })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/rebasePlan', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', base: null }),
    }))
    const request = {
      sessionId: 's',
      requestId: 'r-1',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      entries: [{ sha: 'c'.repeat(40), action: 'reword' as const, message: 'new' }],
      updateRefs: true,
      stash: true,
    }
    await client.interactiveRebase(request)
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/interactiveRebase', expect.objectContaining({
      body: JSON.stringify(request),
    }))
  })
})

describe('createGitClient / B2 history endpoints', () => {
  it('posts blame, fileHistory and compare to their endpoint paths', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)

    await client.blame({ sessionId: 's', path: 'a b.txt', rev: 'main', start: 2001, limit: 2000 })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/blame', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', path: 'a b.txt', rev: 'main', start: 2001, limit: 2000 }),
    }))
    await client.fileHistory({ sessionId: 's', path: 'src/x.ts', cursor: 'v1:abc:50' })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/fileHistory', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', path: 'src/x.ts', cursor: 'v1:abc:50' }),
    }))
    await client.compare({ sessionId: 's', left: 'feature', right: null })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/compare', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', left: 'feature', right: null }),
    }))
  })

  it('passes the range scope of diff through unchanged', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} })))
    vi.stubGlobal('fetch', fetch)
    const client = createGitClient(undefined)

    await client.diff({ sessionId: 's', path: 'a.txt', scope: 'range', from: 'main', to: 'feature', mergeBase: true })
    expect(fetch).toHaveBeenLastCalledWith('dsh-git/diff', expect.objectContaining({
      body: JSON.stringify({ sessionId: 's', path: 'a.txt', scope: 'range', from: 'main', to: 'feature', mergeBase: true }),
    }))
  })
})
