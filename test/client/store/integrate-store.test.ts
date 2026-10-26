// A3 T8 integrate-store: remembered form defaults (never the risk checkboxes), request builders and
// small pure rules shared by the merge / pull / update / reset forms.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  hasTrackedChanges,
  loadPrefs,
  mergeRequestOf,
  pullDefaults,
  resolveRemoteRef,
  savePrefs,
} from '../../../src/client/store/integrate-store.ts'
import type { StatusValue } from '../../../src/shared/protocol.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

describe('prefs', () => {
  it('defaults: plain merge, pull by merge, update by merge, no prune, mixed reset', () => {
    expect(loadPrefs(memoryStorage())).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toEqual({ merge: 'default', pull: 'merge', update: 'merge', prune: false, reset: 'mixed' })
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS)
  })

  it('remembers the last choices', () => {
    const storage = memoryStorage()
    savePrefs(storage, { merge: 'squash', pull: 'rebase', update: 'rebase', prune: true, reset: 'soft' })
    expect(loadPrefs(storage)).toEqual({ merge: 'squash', pull: 'rebase', update: 'rebase', prune: true, reset: 'soft' })
  })

  it('never stores risk checkboxes and never remembers hard reset', () => {
    const storage = memoryStorage()
    savePrefs(storage, { ...DEFAULT_PREFS, reset: 'hard' as never })
    const raw = storage.data.get(PREFS_KEY) ?? ''
    expect(raw).not.toMatch(/confirm|backup|risk/i)
    expect(loadPrefs(storage).reset).toBe('mixed')
  })

  it('ignores corrupt or hostile storage content', () => {
    expect(loadPrefs(memoryStorage({ [PREFS_KEY]: 'not json' }))).toEqual(DEFAULT_PREFS)
    expect(loadPrefs(memoryStorage({ [PREFS_KEY]: JSON.stringify({ merge: 'evil', pull: 3, prune: 'yes', reset: 'hard' }) }))).toEqual(DEFAULT_PREFS)
  })

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS)
    expect(() => { savePrefs(broken, DEFAULT_PREFS) }).not.toThrow()
  })
})

describe('mergeRequestOf', () => {
  it('maps the option to the request flags', () => {
    expect(mergeRequestOf('feat/x', 'default')).toEqual({ ref: 'feat/x' })
    expect(mergeRequestOf('feat/x', 'noFf')).toEqual({ ref: 'feat/x', noFf: true })
    expect(mergeRequestOf('feat/x', 'squash')).toEqual({ ref: 'feat/x', squash: true })
    expect(mergeRequestOf('feat/x', 'noCommit')).toEqual({ ref: 'feat/x', noCommit: true })
  })
})

describe('resolveRemoteRef', () => {
  it('splits at the longest matching remote (remote names may contain a slash)', () => {
    expect(resolveRemoteRef(['origin', 'team/fork'], 'origin/feat/x')).toEqual({ remote: 'origin', branch: 'feat/x' })
    expect(resolveRemoteRef(['origin', 'team', 'team/fork'], 'team/fork/main')).toEqual({ remote: 'team/fork', branch: 'main' })
    expect(resolveRemoteRef(['origin'], 'nope/main')).toBeNull()
    expect(resolveRemoteRef(['origin'], 'origin/')).toBeNull()
  })
})

describe('pullDefaults', () => {
  const base = { remotes: ['origin', 'team/fork'], defaultRemote: 'origin', upstream: 'origin/main', branch: 'main' }

  it('uses the upstream of the current branch', () => {
    expect(pullDefaults(base)).toEqual({ remote: 'origin', branch: 'main' })
  })

  it('a prefill from a branch row wins; its remote is resolved against the remote list', () => {
    expect(pullDefaults({ ...base, prefill: { remote: 'team', branch: 'fork/feat/x' } })).toEqual({ remote: 'team/fork', branch: 'feat/x' })
    expect(pullDefaults({ ...base, prefill: { remote: 'origin', branch: 'feat/ui' } })).toEqual({ remote: 'origin', branch: 'feat/ui' })
  })

  it('falls back to the default remote and the current branch name without an upstream', () => {
    expect(pullDefaults({ ...base, upstream: null })).toEqual({ remote: 'origin', branch: 'main' })
    expect(pullDefaults({ remotes: [], defaultRemote: null, upstream: null, branch: null })).toEqual({ remote: '', branch: '' })
  })
})

describe('hasTrackedChanges', () => {
  const status = (patch: Partial<StatusValue>): StatusValue => ({
    branch: 'main', detached: false, head: 'a', upstream: 'origin/main', ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], conflicts: [], operation: null, truncated: false, ...patch,
  })
  const file = { path: 'a.ts', status: 'M' } as never
  it('counts staged and unstaged changes but not untracked files', () => {
    expect(hasTrackedChanges(null)).toBe(false)
    expect(hasTrackedChanges(status({ untracked: [file] }))).toBe(false)
    expect(hasTrackedChanges(status({ unstaged: [file] }))).toBe(true)
    expect(hasTrackedChanges(status({ staged: [file] }))).toBe(true)
  })
})
