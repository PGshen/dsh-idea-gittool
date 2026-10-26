// Commit page changes tree (design §8.2.2): grouping, tri-state checks, search and the UI store.
// React-free so it can be unit tested; the workbench owns one store per session, so checks
// survive page switches and status refreshes.
import { useSyncExternalStore } from 'react'
import type { FileEntry, FileStatusCode, StatusValue } from '../../shared/protocol.ts'

/** Visible strings of this module; moved into the locale namespace in T7. */
export const TEXT = {
  groupConflicts: '冲突',
  groupModified: '已修改',
  groupAdded: '新增',
  groupDeleted: '删除',
  groupRenamed: '重命名',
  groupUntracked: '未版本控制',
} as const

/** Replaces `{name}` placeholders; unknown names are left as-is. */
export function fillText(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type ChangeGroupKind = 'conflicts' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export const CHANGE_GROUP_ORDER: readonly ChangeGroupKind[] = ['conflicts', 'modified', 'added', 'deleted', 'renamed', 'untracked']

export const CHANGE_GROUP_LABEL: Readonly<Record<ChangeGroupKind, string>> = {
  conflicts: TEXT.groupConflicts,
  modified: TEXT.groupModified,
  added: TEXT.groupAdded,
  deleted: TEXT.groupDeleted,
  renamed: TEXT.groupRenamed,
  untracked: TEXT.groupUntracked,
}

/** One changed path, merged across the staged/unstaged/untracked/conflict lists. */
export interface ChangeEntry extends FileEntry {
  group: ChangeGroupKind
  staged: boolean
  unstaged: boolean
  /** Which diff the row opens: worktree when the file has unstaged changes, else the staged one. */
  diffScope: 'worktree' | 'staged'
}

const GROUP_OF: Record<FileStatusCode, ChangeGroupKind> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  U: 'conflicts',
  '?': 'untracked',
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Natural, case-insensitive path order with a stable tie-break. */
export function comparePaths(left: string, right: string): number {
  const order = collator.compare(left, right)
  if (order !== 0) return order
  return left < right ? -1 : left > right ? 1 : 0
}

function sumOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined
  return (left ?? 0) + (right ?? 0)
}

/** Status shown for a path that is both staged and modified in the worktree. */
function mergedStatus(staged: FileEntry | undefined, unstaged: FileEntry | undefined): FileStatusCode {
  if (staged !== undefined && (staged.status === 'A' || staged.status === 'R' || staged.status === 'C')) return staged.status
  if (unstaged?.status === 'D' || staged?.status === 'D') return 'D'
  return unstaged?.status ?? staged?.status ?? 'M'
}

/**
 * Flattens a status snapshot into one entry per path, sorted by group then path.
 * @param status - the bootstrap/status snapshot, or null before the first load.
 * @returns de-duplicated change entries.
 */
export function collectChanges(status: StatusValue | null): ChangeEntry[] {
  if (status === null) return []
  const byPath = new Map<string, ChangeEntry>()
  for (const conflict of status.conflicts) {
    byPath.set(conflict.path, { ...conflict, status: 'U', group: 'conflicts', staged: false, unstaged: true, diffScope: 'worktree' })
  }
  const staged = new Map(status.staged.map(file => [file.path, file]))
  const unstaged = new Map(status.unstaged.map(file => [file.path, file]))
  for (const path of new Set([...staged.keys(), ...unstaged.keys()])) {
    if (byPath.has(path)) continue
    const inIndex = staged.get(path)
    const inTree = unstaged.get(path)
    const status = mergedStatus(inIndex, inTree)
    const change: ChangeEntry = {
      path,
      status,
      group: GROUP_OF[status],
      staged: inIndex !== undefined,
      unstaged: inTree !== undefined,
      diffScope: inTree === undefined ? 'staged' : 'worktree',
    }
    const origPath = inIndex?.origPath ?? inTree?.origPath
    if (origPath !== undefined) change.origPath = origPath
    const additions = sumOf(inIndex?.additions, inTree?.additions)
    const deletions = sumOf(inIndex?.deletions, inTree?.deletions)
    if (additions !== undefined) change.additions = additions
    if (deletions !== undefined) change.deletions = deletions
    byPath.set(path, change)
  }
  for (const file of status.untracked) {
    if (byPath.has(file.path)) continue
    byPath.set(file.path, { path: file.path, status: '?', group: 'untracked', staged: false, unstaged: false, diffScope: 'worktree' })
  }
  const rank = new Map(CHANGE_GROUP_ORDER.map((kind, index) => [kind, index]))
  return [...byPath.values()].sort((left, right) =>
    (rank.get(left.group) ?? 0) - (rank.get(right.group) ?? 0) || comparePaths(left.path, right.path))
}

/** Tab badge: conflicts + staged + unstaged + untracked, de-duplicated by path. */
export function uncommittedCount(status: StatusValue | null): number {
  if (status === null) return 0
  const paths = new Set<string>()
  for (const list of [status.conflicts, status.staged, status.unstaged, status.untracked]) {
    for (const file of list) paths.add(file.path)
  }
  return paths.size
}

export function isCheckable(change: ChangeEntry): boolean {
  return change.group !== 'conflicts'
}

// ---------------------------------------------------------------------------
// Tree view model
// ---------------------------------------------------------------------------

export type CheckState = 'all' | 'some' | 'none'

export interface ChangeTreeFile {
  kind: 'file'
  key: string
  name: string
  depth: number
  entry: ChangeEntry
  checked: boolean
  /** Conflict rows cannot be checked (resolved in A3). */
  disabled: boolean
}

export interface ChangeTreeDir {
  kind: 'dir'
  /** `d:<group>:<path>`; also the collapse and toggle key. */
  key: string
  /** Display name; single-child chains are compacted (`client/log`). */
  name: string
  path: string
  depth: number
  /** Visible files in the subtree. */
  count: number
  check: CheckState
  checkable: boolean
  collapsed: boolean
  /** Empty while collapsed. */
  children: ChangeTreeNode[]
}

export type ChangeTreeNode = ChangeTreeFile | ChangeTreeDir

export interface ChangeGroupView {
  kind: ChangeGroupKind
  /** `g:<group>`. */
  key: string
  label: string
  count: number
  check: CheckState
  checkable: boolean
  collapsed: boolean
  nodes: ChangeTreeNode[]
}

export interface BuildGroupsOptions {
  checked: ReadonlySet<string>
  search?: string
  collapsed?: Readonly<Record<string, boolean>>
}

export function groupKey(kind: ChangeGroupKind): string {
  return `g:${kind}`
}

export function dirKey(kind: ChangeGroupKind, path: string): string {
  return `d:${kind}:${path}`
}

/** Case-insensitive path/original-path match; an empty query matches everything. */
export function matchesSearch(change: ChangeEntry, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (query === '') return true
  return change.path.toLowerCase().includes(query) || (change.origPath?.toLowerCase().includes(query) ?? false)
}

function checkStateOf(changes: readonly ChangeEntry[], checked: ReadonlySet<string>): { check: CheckState; checkable: boolean } {
  const candidates = changes.filter(isCheckable)
  if (candidates.length === 0) return { check: 'none', checkable: false }
  const count = candidates.filter(change => checked.has(change.path)).length
  return { check: count === 0 ? 'none' : count === candidates.length ? 'all' : 'some', checkable: true }
}

interface MutableDir {
  name: string
  path: string
  dirs: Map<string, MutableDir>
  files: ChangeEntry[]
}

function filesUnder(dir: MutableDir): ChangeEntry[] {
  return [...dir.files, ...[...dir.dirs.values()].flatMap(filesUnder)]
}

function toNodes(
  dir: MutableDir,
  kind: ChangeGroupKind,
  depth: number,
  options: BuildGroupsOptions,
): ChangeTreeNode[] {
  const dirs: ChangeTreeDir[] = []
  for (const child of dir.dirs.values()) {
    // Compact `a/b/c` chains that hold only one sub-directory and no files.
    let node = child
    let name = child.name
    while (node.files.length === 0 && node.dirs.size === 1) {
      const only = [...node.dirs.values()][0]
      if (only === undefined) break
      name = `${name}/${only.name}`
      node = only
    }
    const key = dirKey(kind, node.path)
    const files = filesUnder(node)
    const collapsed = options.collapsed?.[key] === true
    dirs.push({
      kind: 'dir',
      key,
      name,
      path: node.path,
      depth,
      count: files.length,
      ...checkStateOf(files, options.checked),
      collapsed,
      children: collapsed ? [] : toNodes(node, kind, depth + 1, options),
    })
  }
  dirs.sort((left, right) => comparePaths(left.name, right.name))
  const files: ChangeTreeFile[] = [...dir.files]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map(change => ({
      kind: 'file',
      key: `f:${change.path}`,
      name: change.path.slice(change.path.lastIndexOf('/') + 1),
      depth,
      entry: change,
      checked: options.checked.has(change.path),
      disabled: !isCheckable(change),
    }))
  return [...dirs, ...files]
}

function treeOf(changes: readonly ChangeEntry[]): MutableDir {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const change of changes) {
    const parts = change.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (next === undefined) {
        next = { name: part, path: dir.path === '' ? part : `${dir.path}/${part}`, dirs: new Map(), files: [] }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.push(change)
  }
  return root
}

/**
 * Groups visible changes and builds a directory tree per group.
 * @param changes - entries from {@link collectChanges}.
 * @param options - checked paths, search text and collapsed keys.
 * @returns non-empty groups in {@link CHANGE_GROUP_ORDER}.
 */
export function buildChangeGroups(changes: readonly ChangeEntry[], options: BuildGroupsOptions): ChangeGroupView[] {
  const visible = changes.filter(change => matchesSearch(change, options.search ?? ''))
  const groups: ChangeGroupView[] = []
  for (const kind of CHANGE_GROUP_ORDER) {
    const members = visible.filter(change => change.group === kind)
    if (members.length === 0) continue
    const key = groupKey(kind)
    const collapsed = options.collapsed?.[key] === true
    groups.push({
      kind,
      key,
      label: CHANGE_GROUP_LABEL[kind],
      count: members.length,
      ...checkStateOf(members, options.checked),
      collapsed,
      nodes: collapsed ? [] : toNodes(treeOf(members), kind, 1, options),
    })
  }
  return groups
}

/** Visible changes under a group (`g:`) or directory (`d:`) key. */
export function changesUnder(changes: readonly ChangeEntry[], key: string, search: string): ChangeEntry[] {
  const visible = changes.filter(change => matchesSearch(change, search))
  if (key.startsWith('g:')) {
    const kind = key.slice(2)
    return visible.filter(change => change.group === kind)
  }
  if (key.startsWith('d:')) {
    const rest = key.slice(2)
    const at = rest.indexOf(':')
    const kind = rest.slice(0, at)
    const prefix = `${rest.slice(at + 1)}/`
    return visible.filter(change => change.group === kind && change.path.startsWith(prefix))
  }
  return []
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ChangesState {
  /** Sorted, de-duplicated entries of the latest adopted status. */
  entries: ChangeEntry[]
  checked: ReadonlySet<string>
  search: string
  /** Collapsed group/dir keys. */
  collapsed: Readonly<Record<string, boolean>>
  /** Keyboard focus row (path). */
  focused: string | null
  /** True once a status has been adopted. */
  loaded: boolean
  truncated: boolean
  version?: number
}

export interface ChangesStoreOptions {
  /** Checks applied on the first adopted status: IntelliJ-style `tracked` (default) or `none`. */
  initialChecked?: 'none' | 'tracked'
}

export interface ChangesStore {
  getState(): ChangesState
  subscribe(listener: () => void): () => void
  /** Adopts a status snapshot: keeps checks of surviving paths, drops vanished ones, ignores older versions. */
  setStatus(status: StatusValue | null): void
  toggleFile(path: string): void
  setChecked(paths: readonly string[], checked: boolean): void
  /** Tri-state toggle of a group/dir: all checked → none, otherwise → all (visible files only). */
  toggleNode(key: string): void
  /** Checks or clears every visible checkable file. */
  checkAll(checked: boolean): void
  /** "Commit this file…": only this path stays checked. */
  checkOnly(path: string): void
  /** Removes checks (e.g. committed paths after a successful commit). */
  uncheck(paths: readonly string[]): void
  setSearch(search: string): void
  toggleCollapsed(key: string): void
  setFocused(path: string | null): void
  /** Checked paths in entry order. */
  getCheckedPaths(): string[]
  reset(): void
}

const emptyState = (): ChangesState => ({
  entries: [],
  checked: new Set(),
  search: '',
  collapsed: {},
  focused: null,
  loaded: false,
  truncated: false,
})

export function createChangesStore(options: ChangesStoreOptions = {}): ChangesStore {
  const initialChecked = options.initialChecked ?? 'tracked'
  const listeners = new Set<() => void>()
  let state = emptyState()

  const emit = (patch: Partial<ChangesState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const checkablePaths = (paths: readonly string[]): string[] => {
    const known = new Map(state.entries.map(change => [change.path, change]))
    return paths.filter((path) => {
      const change = known.get(path)
      return change !== undefined && isCheckable(change)
    })
  }

  const setChecked = (paths: readonly string[], checked: boolean): void => {
    const next = new Set(state.checked)
    const targets = checked ? checkablePaths(paths) : paths
    for (const path of targets) {
      if (checked) next.add(path)
      else next.delete(path)
    }
    emit({ checked: next })
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setStatus(status) {
      if (status === null) {
        emit({ ...emptyState(), search: state.search, collapsed: state.collapsed })
        return
      }
      if (state.version !== undefined && status.version !== undefined && status.version < state.version) return
      const entries = collectChanges(status)
      const present = new Set(entries.filter(isCheckable).map(change => change.path))
      const checked = state.loaded
        ? new Set([...state.checked].filter(path => present.has(path)))
        : new Set(initialChecked === 'tracked'
          ? entries.filter(change => isCheckable(change) && change.group !== 'untracked').map(change => change.path)
          : [])
      const focused = state.focused !== null && entries.some(change => change.path === state.focused) ? state.focused : null
      const patch: Partial<ChangesState> = { entries, checked, focused, loaded: true, truncated: status.truncated }
      if (status.version !== undefined) patch.version = status.version
      emit(patch)
    },
    toggleFile(path) {
      setChecked([path], !state.checked.has(path))
    },
    setChecked,
    toggleNode(key) {
      const members = changesUnder(state.entries, key, state.search).filter(isCheckable)
      if (members.length === 0) return
      const allChecked = members.every(change => state.checked.has(change.path))
      setChecked(members.map(change => change.path), !allChecked)
    },
    checkAll(checked) {
      const visible = state.entries.filter(change => matchesSearch(change, state.search)).map(change => change.path)
      setChecked(visible, checked)
    },
    checkOnly(path) {
      const allowed = checkablePaths([path])
      if (allowed.length === 0) return
      emit({ checked: new Set(allowed), focused: path })
    },
    uncheck(paths) {
      setChecked(paths, false)
    },
    setSearch: search => emit({ search }),
    toggleCollapsed(key) {
      const next = { ...state.collapsed }
      if (next[key] === true) delete next[key]
      else next[key] = true
      emit({ collapsed: next })
    },
    setFocused: focused => emit({ focused }),
    getCheckedPaths: () => state.entries.filter(change => state.checked.has(change.path)).map(change => change.path),
    reset: () => emit(emptyState()),
  }
}

/** Subscribes a component to the changes store. */
export function useChangesState(store: ChangesStore): ChangesState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
