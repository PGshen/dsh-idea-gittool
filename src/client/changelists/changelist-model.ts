// Changelists (design §8.2.2 P1, plan b3c T4): named groups of uncommitted files, kept per browser and
// per repository (design §13). Pure functions; every change returns a new state, a no-op returns the
// same object so callers can skip saving and re-rendering.

/** The list that always exists; its display name comes from the dictionary. */
export const DEFAULT_LIST = 'default'
/** Storage key prefix; the repository root follows. */
export const CHANGELISTS_KEY_PREFIX = 'dsh-idea-git.changelists.v1:'
const NAME_MAX = 100

export interface Changelist {
  id: string
  /** Empty for the default list (rendered as "Changes"). */
  name: string
}

export interface ChangelistState {
  lists: Changelist[]
  active: string
  /** Path → list id; a path without an entry belongs to the default list. */
  assignment: Readonly<Record<string, string>>
}

export function emptyChangelists(): ChangelistState {
  return { lists: [{ id: DEFAULT_LIST, name: '' }], active: DEFAULT_LIST, assignment: {} }
}

const has = (state: ChangelistState, id: string): boolean => state.lists.some(list => list.id === id)

export function listOf(state: ChangelistState, path: string): string {
  const id = state.assignment[path]
  return id !== undefined && has(state, id) ? id : DEFAULT_LIST
}

export function addList(state: ChangelistState, name: string): { state: ChangelistState; id: string } {
  const trimmed = name.trim().slice(0, NAME_MAX)
  let id = `cl-${Date.now().toString(36)}`
  while (has(state, id)) id = `${id}x`
  return { state: { ...state, lists: [...state.lists, { id, name: trimmed }] }, id }
}

export function renameList(state: ChangelistState, id: string, name: string): ChangelistState {
  const trimmed = name.trim().slice(0, NAME_MAX)
  if (trimmed === '' || id === DEFAULT_LIST || !has(state, id)) return state
  return { ...state, lists: state.lists.map(list => (list.id === id ? { ...list, name: trimmed } : list)) }
}

/** Remove a list (never the default); its files go back to the default list. */
export function removeList(state: ChangelistState, id: string): ChangelistState {
  if (id === DEFAULT_LIST || !has(state, id)) return state
  const assignment = Object.fromEntries(Object.entries(state.assignment).filter(([, list]) => list !== id))
  return { lists: state.lists.filter(list => list.id !== id), active: state.active === id ? DEFAULT_LIST : state.active, assignment }
}

export function setActive(state: ChangelistState, id: string): ChangelistState {
  return has(state, id) && state.active !== id ? { ...state, active: id } : state
}

export function moveTo(state: ChangelistState, paths: readonly string[], id: string): ChangelistState {
  if (!has(state, id) || paths.length === 0) return state
  const assignment = { ...state.assignment }
  for (const path of paths) assignment[path] = id
  return { ...state, assignment }
}

/** Follow the current changes: new paths join the active list, paths without changes are forgotten. */
export function syncPaths(state: ChangelistState, changed: readonly string[]): ChangelistState {
  const present = new Set(changed)
  let dirty = false
  const assignment: Record<string, string> = {}
  for (const [path, id] of Object.entries(state.assignment)) {
    if (present.has(path) && has(state, id)) assignment[path] = id
    else dirty = true
  }
  for (const path of changed) {
    if (assignment[path] !== undefined) continue
    assignment[path] = state.active
    dirty = true
  }
  return dirty ? { ...state, assignment } : state
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function isState(value: unknown): value is ChangelistState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ChangelistState>
  if (!Array.isArray(record.lists) || typeof record.active !== 'string' || typeof record.assignment !== 'object' || record.assignment === null) return false
  if (!record.lists.some(list => list?.id === DEFAULT_LIST)) return false
  if (!record.lists.every(list => typeof list?.id === 'string' && typeof list.name === 'string')) return false
  return Object.values(record.assignment).every(id => typeof id === 'string')
}

/** The saved state of `repoRoot`, or the default when nothing usable is stored. */
export function loadChangelists(storage: StorageLike | null, repoRoot: string): ChangelistState {
  try {
    const raw = storage?.getItem(`${CHANGELISTS_KEY_PREFIX}${repoRoot}`)
    if (raw === null || raw === undefined) return emptyChangelists()
    const parsed: unknown = JSON.parse(raw)
    if (!isState(parsed)) return emptyChangelists()
    return { ...parsed, active: has(parsed, parsed.active) ? parsed.active : DEFAULT_LIST }
  } catch {
    return emptyChangelists()
  }
}

export function saveChangelists(storage: StorageLike | null, repoRoot: string, state: ChangelistState): void {
  try {
    storage?.setItem(`${CHANGELISTS_KEY_PREFIX}${repoRoot}`, JSON.stringify(state))
  } catch {
    // Storage unavailable: the lists last for this page only.
  }
}

/** One list as the commit page shows it. */
export interface ChangelistSection<E extends { path: string }> {
  list: Changelist
  active: boolean
  entries: E[]
  check: 'none' | 'some' | 'all'
  checkable: boolean
}

/**
 * Visible changes per list (default first, then in creation order; empty lists kept so they can take
 * drops). `checkable` follows the commit page: conflicts cannot be checked.
 */
export function changelistSections<E extends { path: string; group: string }>(
  entries: readonly E[],
  state: ChangelistState,
  checked: ReadonlySet<string>,
): ChangelistSection<E>[] {
  return state.lists.map((list) => {
    const members = entries.filter(entry => listOf(state, entry.path) === list.id)
    const candidates = members.filter(entry => entry.group !== 'conflicts')
    const count = candidates.filter(entry => checked.has(entry.path)).length
    return {
      list,
      active: state.active === list.id,
      entries: members,
      check: count === 0 ? 'none' : count === candidates.length ? 'all' : 'some',
      checkable: candidates.length > 0,
    }
  })
}
