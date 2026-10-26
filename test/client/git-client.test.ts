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
