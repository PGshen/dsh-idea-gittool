// B3c T4: changelists — pure model and per-repository persistence.
import { describe, expect, it } from 'vitest'

import {
  CHANGELISTS_KEY_PREFIX,
  DEFAULT_LIST,
  addList,
  changelistSections,
  emptyChangelists,
  listOf,
  loadChangelists,
  moveTo,
  removeList,
  renameList,
  saveChangelists,
  setActive,
  syncPaths,
} from '../../../src/client/changelists/changelist-model.ts'

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value } }
}

describe('changelist model', () => {
  it('starts with the default list active', () => {
    const state = emptyChangelists()
    expect(state.lists.map(list => list.id)).toEqual([DEFAULT_LIST])
    expect(state.active).toBe(DEFAULT_LIST)
    expect(listOf(state, 'a.txt')).toBe(DEFAULT_LIST)
  })

  it('adds, renames, activates and removes lists; the default list stays', () => {
    const { state: added, id } = addList(emptyChangelists(), '调试')
    expect(added.lists.map(list => list.name)).toEqual(['', '调试'])
    const renamed = renameList(added, id, '调试用')
    expect(renamed.lists.find(list => list.id === id)?.name).toBe('调试用')
    expect(renameList(renamed, id, '  ')).toBe(renamed)
    const active = setActive(moveTo(renamed, ['a.txt'], id), id)
    expect(active.active).toBe(id)
    const removed = removeList(active, id)
    expect(removed.lists.map(list => list.id)).toEqual([DEFAULT_LIST])
    expect(removed.active).toBe(DEFAULT_LIST)
    expect(listOf(removed, 'a.txt')).toBe(DEFAULT_LIST)
    expect(removeList(removed, DEFAULT_LIST)).toBe(removed)
  })

  it('moves files between lists and ignores unknown targets', () => {
    const { state, id } = addList(emptyChangelists(), 'x')
    const moved = moveTo(state, ['a.txt', 'b.txt'], id)
    expect([listOf(moved, 'a.txt'), listOf(moved, 'b.txt'), listOf(moved, 'c.txt')]).toEqual([id, id, DEFAULT_LIST])
    expect(moveTo(moved, ['a.txt'], 'missing')).toBe(moved)
  })

  it('puts new changes into the active list and forgets paths that are no longer changed', () => {
    const { state, id } = addList(emptyChangelists(), 'x')
    const active = setActive(state, id)
    const synced = syncPaths(active, ['new.txt', 'kept.txt'])
    expect(listOf(synced, 'new.txt')).toBe(id)
    const later = syncPaths(setActive(moveTo(synced, ['kept.txt'], DEFAULT_LIST), DEFAULT_LIST), ['kept.txt'])
    expect(Object.keys(later.assignment)).toEqual(['kept.txt'])
    expect(listOf(later, 'kept.txt')).toBe(DEFAULT_LIST)
    expect(syncPaths(later, ['kept.txt'])).toBe(later)
  })
})

describe('changelist persistence', () => {
  it('saves per repository and loads back', () => {
    const storage = memory()
    const { state, id } = addList(emptyChangelists(), 'x')
    saveChangelists(storage, '/repo', moveTo(state, ['a.txt'], id))
    expect(Object.keys(storage.data)).toEqual([`${CHANGELISTS_KEY_PREFIX}/repo`])
    expect(listOf(loadChangelists(storage, '/repo'), 'a.txt')).toBe(id)
    expect(loadChangelists(storage, '/other')).toEqual(emptyChangelists())
  })

  it('falls back to the default on broken or unavailable storage', () => {
    expect(loadChangelists(memory({ [`${CHANGELISTS_KEY_PREFIX}/repo`]: '{bad' }), '/repo')).toEqual(emptyChangelists())
    expect(loadChangelists(memory({ [`${CHANGELISTS_KEY_PREFIX}/repo`]: JSON.stringify({ lists: [], active: 'x', assignment: { a: 'y' } }) }), '/repo')).toEqual(emptyChangelists())
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadChangelists(throwing, '/repo')).toEqual(emptyChangelists())
    expect(() => { saveChangelists(throwing, '/repo', emptyChangelists()) }).not.toThrow()
    expect(loadChangelists(null, '/repo')).toEqual(emptyChangelists())
  })
})

describe('changelistSections', () => {
  const entry = (path: string, group = 'modified'): { path: string; group: string } => ({ path, group })

  it('groups visible changes by list, default first, with tri-state checks and the active mark', () => {
    const { state, id } = addList(emptyChangelists(), '调试')
    const assigned = setActive(moveTo(state, ['b.txt'], id), id)
    const sections = changelistSections([entry('a.txt'), entry('b.txt'), entry('c.txt')], assigned, new Set(['a.txt', 'b.txt']))
    expect(sections.map(section => [section.list.id, section.entries.map(change => change.path), section.check, section.active])).toEqual([
      [DEFAULT_LIST, ['a.txt', 'c.txt'], 'some', false],
      [id, ['b.txt'], 'all', true],
    ])
  })

  it('keeps empty lists and leaves conflicts uncheckable', () => {
    const { state } = addList(emptyChangelists(), 'empty')
    const sections = changelistSections([entry('x.txt', 'conflicts')], state, new Set())
    expect(sections).toHaveLength(2)
    expect(sections[0]?.check).toBe('none')
    expect(sections[0]?.checkable).toBe(false)
    expect(sections[1]?.entries).toEqual([])
  })
})

describe('changelist grouping preference', () => {
  it('is remembered in the settings', async () => {
    const { readChangelistGrouping, writeChangelistGrouping } = await import('../../../src/client/settings.ts')
    const data: Record<string, string> = {}
    const storage = { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value } }
    const original = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = storage
    try {
      expect(readChangelistGrouping()).toBe(false)
      writeChangelistGrouping(true)
      expect(readChangelistGrouping()).toBe(true)
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = original
    }
  })
})

describe('syncPaths before the first status (L4 finding)', () => {
  it('leaves assignments alone while the changes are not known yet', () => {
    const { state, id } = addList(emptyChangelists(), 'x')
    const assigned = moveTo(state, ['a.txt'], id)
    expect(syncPaths(assigned, null)).toBe(assigned)
    expect(listOf(syncPaths(assigned, ['a.txt']), 'a.txt')).toBe(id)
  })
})
