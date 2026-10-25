// 分支面板的纯逻辑（设计 §5.4、§8.1.4）：响应式档位、分组建模、搜索、单击/双击分流与 UI store。
// 不依赖 DOM；RPC 由外部注入（Lead 在 src/client/index.ts 接 git-client 的 branches 端点）。
import { useSyncExternalStore } from 'react'
import type { BranchEntry, BranchesValue, GitError } from '../../shared/protocol.ts'

// ---------------------------------------------------------------------------
// 响应式档位
// ---------------------------------------------------------------------------

/** 面板宽度三档：Compact 300–599 / Standard 600–999 / Wide ≥1000（设计 §5.4）。 */
export type PanelMode = 'compact' | 'standard' | 'wide'

export const STANDARD_MIN_WIDTH = 600
export const WIDE_MIN_WIDTH = 1000

/** 按 Git tab 内容区宽度给出档位；宽度缺失或非法时退回 standard。 */
export function panelModeForWidth(width: number): PanelMode {
  if (!Number.isFinite(width)) return 'standard'
  if (width >= WIDE_MIN_WIDTH) return 'wide'
  if (width >= STANDARD_MIN_WIDTH) return 'standard'
  return 'compact'
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** `↑n ↓n`，只显示非零方向；都为 0 时返回空串。 */
export function formatAheadBehind(ahead: number, behind: number): string {
  const parts: string[] = []
  if (ahead > 0) parts.push(`↑${ahead}`)
  if (behind > 0) parts.push(`↓${behind}`)
  return parts.join(' ')
}

/** 7 位短哈希。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

// ---------------------------------------------------------------------------
// 分组建模
// ---------------------------------------------------------------------------

export type BranchGroupKind = 'head' | 'local' | 'remote' | 'tags'

export const BRANCH_GROUP_ORDER: readonly BranchGroupKind[] = ['head', 'local', 'remote', 'tags']

const GROUP_LABEL: Record<BranchGroupKind, string> = {
  head: 'HEAD',
  local: 'Local',
  remote: 'Remote',
  tags: 'Tags',
}

export type CollapsedGroups = Record<BranchGroupKind, boolean>

/** 默认折叠：Remote/Tags 收起，HEAD/Local 展开。 */
export const DEFAULT_COLLAPSED_GROUPS: Readonly<CollapsedGroups> = Object.freeze({
  head: false,
  local: false,
  remote: true,
  tags: true,
})

/** 面板中的一行：分支叶子或目录（`feat/login` → `feat ▸ login`）。 */
export interface BranchRow {
  kind: 'branch' | 'directory'
  /** 行内唯一 key（分组 + 路径）。 */
  key: string
  /** 显示名：叶子是最后一段（flat 模式为完整短名），目录是目录名。 */
  label: string
  /** 在分组内的缩进深度，根为 0。 */
  depth: number
  /** 目录行的完整路径（如 `feat`、`origin/feat`），也是 collapsedDirs 的键。 */
  path?: string
  /** 叶子行对应的协议条目；detached HEAD 伪行也会合成一个。 */
  entry?: BranchEntry
  current: boolean
  head: boolean
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  /** 目录行：子树中的分支数。 */
  childCount?: number
  /** 目录行：是否折叠。 */
  directoryCollapsed?: boolean
}

export interface BranchGroup {
  kind: BranchGroupKind
  label: string
  /** 可见行；分组折叠时为空。 */
  rows: BranchRow[]
  /** 过滤后的分支数（不含目录行），折叠时保留。 */
  total: number
  collapsed: boolean
}

export interface GroupBranchesOptions {
  search?: string
  flat?: boolean
  collapsedGroups?: Partial<CollapsedGroups>
  collapsedDirs?: Readonly<Record<string, boolean>>
}

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  leaves: BranchEntry[]
}

const compareEntries = (a: BranchEntry, b: BranchEntry): number => {
  if (a.current !== b.current) return a.current ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function leafRow(group: BranchGroupKind, entry: BranchEntry, label: string, depth: number): BranchRow {
  const row: BranchRow = {
    kind: 'branch',
    key: `${group}:${entry.ref}`,
    label,
    depth,
    entry,
    current: entry.current,
    head: entry.head,
    detached: false,
    ahead: entry.ahead,
    behind: entry.behind,
  }
  if (entry.upstream !== undefined) row.upstream = entry.upstream
  return row
}

function countLeaves(node: TreeNode): number {
  let total = node.leaves.length
  for (const child of node.children.values()) total += countLeaves(child)
  return total
}

function buildTree(entries: readonly BranchEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), leaves: [] }
  for (const entry of entries) {
    const segments = entry.name.split('/')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      const path = node.path === '' ? segment : `${node.path}/${segment}`
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { name: segment, path, children: new Map(), leaves: [] }
        node.children.set(segment, child)
      }
      node = child
    }
    node.leaves.push(entry)
  }
  return root
}

function flattenTree(
  group: BranchGroupKind,
  node: TreeNode,
  depth: number,
  collapsedDirs: Readonly<Record<string, boolean>>,
  rows: BranchRow[],
): void {
  // 同一层：叶子在前（当前分支最前，其余按名称），目录收拢在后。
  for (const entry of [...node.leaves].sort(compareEntries)) {
    rows.push(leafRow(group, entry, entry.name.split('/').at(-1) ?? entry.name, depth))
  }
  const children = [...node.children.values()].sort((a, b) => compareText(a.name, b.name))
  for (const child of children) {
    const collapsed = collapsedDirs[child.path] === true
    rows.push({
      kind: 'directory',
      key: `${group}:dir:${child.path}`,
      label: child.name,
      depth,
      path: child.path,
      current: false,
      head: false,
      detached: false,
      ahead: 0,
      behind: 0,
      childCount: countLeaves(child),
      directoryCollapsed: collapsed,
    })
    if (!collapsed) flattenTree(group, child, depth + 1, collapsedDirs, rows)
  }
}

function headRows(value: BranchesValue): BranchRow[] {
  const { head } = value
  if (head.detached) {
    const sha = head.sha ?? ''
    const entry: BranchEntry = {
      ref: 'HEAD',
      name: 'HEAD',
      kind: 'local',
      sha,
      head: true,
      current: false,
      ahead: 0,
      behind: 0,
    }
    return [{
      kind: 'branch',
      key: 'head:HEAD',
      label: shortSha(sha),
      depth: 0,
      entry,
      current: false,
      head: true,
      detached: true,
      ahead: 0,
      behind: 0,
    }]
  }
  if (head.branch === null) return []
  const current = value.local.find(entry => entry.current) ?? value.local.find(entry => entry.name === head.branch)
  if (current !== undefined) {
    return [{ ...leafRow('head', current, current.name, 0), current: true, head: true }]
  }
  // 未诞生的分支（空仓库）：没有条目，只展示名字。
  return [{
    kind: 'branch',
    key: `head:${head.branch}`,
    label: head.branch,
    depth: 0,
    current: true,
    head: true,
    detached: false,
    ahead: 0,
    behind: 0,
  }]
}

const matches = (needle: string, ...texts: string[]): boolean =>
  needle === '' || texts.some(text => text.toLowerCase().includes(needle))

/**
 * 把 branches 端点的值建模成 HEAD → Local → Remote → Tags 四组可见行。
 * 搜索激活时忽略分组/目录折叠，保证命中项可见。
 */
export function groupBranches(value: BranchesValue | null, options: GroupBranchesOptions = {}): BranchGroup[] {
  if (value === null) return []
  const needle = (options.search ?? '').trim().toLowerCase()
  const searching = needle !== ''
  const flat = options.flat === true
  // 未指定的分组视为展开；面板默认折叠由 store 的 DEFAULT_COLLAPSED_GROUPS 提供。
  const collapsedGroups: CollapsedGroups = { head: false, local: false, remote: false, tags: false, ...options.collapsedGroups }
  const collapsedDirs = searching ? {} : (options.collapsedDirs ?? {})

  const groups: BranchGroup[] = []
  for (const kind of BRANCH_GROUP_ORDER) {
    let rows: BranchRow[]
    let total: number
    if (kind === 'head') {
      rows = headRows(value).filter(row => matches(needle, row.label, row.entry?.name ?? '', row.detached ? 'detached' : ''))
      total = rows.length
    } else {
      const source = kind === 'local' ? value.local : kind === 'remote' ? value.remote : value.tags
      const entries = source.filter(entry => matches(needle, entry.name))
      total = entries.length
      if (flat || kind === 'tags') {
        rows = [...entries].sort(compareEntries).map(entry => leafRow(kind, entry, entry.name, 0))
      } else {
        rows = []
        flattenTree(kind, buildTree(entries), 0, collapsedDirs, rows)
      }
    }
    const collapsed = !searching && collapsedGroups[kind]
    groups.push({ kind, label: GROUP_LABEL[kind], rows: collapsed ? [] : rows, total, collapsed })
  }
  return groups
}

// ---------------------------------------------------------------------------
// 单击 / 双击分流
// ---------------------------------------------------------------------------

/** 浏览器 dblclick 的典型窗口；单击延迟这么久再导航，给双击留出取消的机会。 */
export const BRANCH_CLICK_DELAY_MS = 220

export interface BranchActivatorOptions<H> {
  /** 单击：把日志导航到该分支 HEAD（不改过滤）。 */
  onNavigate: (entry: BranchEntry) => void
  /** 双击：把日志过滤到该分支。 */
  onFilter: (entry: BranchEntry) => void
  delayMs?: number
  /** 可注入的定时器（测试用）；默认 setTimeout / clearTimeout。 */
  schedule?: (callback: () => void, delayMs: number) => H
  cancel?: (handle: H) => void
}

export interface BranchActivator {
  onClick: (entry: BranchEntry) => void
  onDoubleClick: (entry: BranchEntry) => void
  /** 取消尚未执行的单击（卸载/关闭面板时调用）。 */
  cancel: () => void
}

/**
 * 单击延迟导航、双击取消单击并过滤（设计 §8.1.4，参考项目行为）。
 * @param options - 回调与可注入定时器。
 * @returns 行事件处理器。
 */
export function createBranchActivator<H = ReturnType<typeof setTimeout>>(
  options: BranchActivatorOptions<H>,
): BranchActivator {
  const delay = options.delayMs ?? BRANCH_CLICK_DELAY_MS
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms) as unknown as H)
  const cancelHandle = options.cancel ?? ((handle: H) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>))
  let pending: { handle: H } | undefined

  const cancel = (): void => {
    if (pending === undefined) return
    cancelHandle(pending.handle)
    pending = undefined
  }

  return {
    onClick: (entry) => {
      cancel()
      const task: { handle: H } = {
        handle: schedule(() => {
          if (pending === task) pending = undefined
          options.onNavigate(entry)
        }, delay),
      }
      pending = task
    },
    onDoubleClick: (entry) => {
      cancel()
      options.onFilter(entry)
    },
    cancel,
  }
}

// ---------------------------------------------------------------------------
// UI store
// ---------------------------------------------------------------------------

export interface BranchesState {
  value: BranchesValue | null
  loading: boolean
  error: GitError | null
  search: string
  flat: boolean
  collapsedGroups: CollapsedGroups
  collapsedDirs: Readonly<Record<string, boolean>>
  mode: PanelMode
  /** Standard/Compact 的抽屉/覆盖页是否打开。 */
  open: boolean
  /** Wide 档常驻左栏是否被用户收起。 */
  wideCollapsed: boolean
}

export interface BranchesStore {
  getState(): BranchesState
  /** 订阅变化；订阅时会立即通知一次，便于调用方同步初值。 */
  subscribe(listener: () => void): () => void
  /** 采用 branches 响应；version 比已采用的旧时丢弃。 */
  setValue(value: BranchesValue): void
  setLoading(loading: boolean): void
  setError(error: GitError | null): void
  setSearch(search: string): void
  setFlat(flat: boolean): void
  toggleGroup(kind: BranchGroupKind): void
  toggleDirectory(path: string): void
  setWidth(width: number): void
  setOpen(open: boolean): void
  setWideCollapsed(collapsed: boolean): void
  /** 清空数据与筛选（切换会话时调用）；保留当前档位与显隐。 */
  reset(): void
}

const initialState = (): BranchesState => ({
  value: null,
  loading: false,
  error: null,
  search: '',
  flat: false,
  collapsedGroups: { ...DEFAULT_COLLAPSED_GROUPS },
  collapsedDirs: {},
  mode: 'standard',
  open: false,
  wideCollapsed: false,
})

/** 创建分支面板 UI store。 */
export function createBranchesStore(): BranchesStore {
  const listeners = new Set<() => void>()
  let state = initialState()

  const emit = (patch: Partial<BranchesState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      listener()
      return () => { listeners.delete(listener) }
    },
    setValue: (value) => {
      const current = state.value?.version
      if (current !== undefined && value.version !== undefined && value.version < current) return
      emit({ value, loading: false, error: null })
    },
    setLoading: loading => emit({ loading }),
    setError: error => emit({ error, loading: false }),
    setSearch: search => emit({ search }),
    setFlat: flat => emit({ flat }),
    toggleGroup: kind => emit({ collapsedGroups: { ...state.collapsedGroups, [kind]: !state.collapsedGroups[kind] } }),
    toggleDirectory: (path) => {
      const next = { ...state.collapsedDirs }
      if (next[path] === true) delete next[path]
      else next[path] = true
      emit({ collapsedDirs: next })
    },
    setWidth: (width) => {
      const mode = panelModeForWidth(width)
      if (mode !== state.mode) emit({ mode })
    },
    setOpen: open => emit({ open }),
    setWideCollapsed: wideCollapsed => emit({ wideCollapsed }),
    reset: () => emit({ ...initialState(), mode: state.mode, open: state.open, wideCollapsed: state.wideCollapsed }),
  }
}

/** 把分支 store 接进 React。 */
export function useBranchesState(store: BranchesStore): BranchesState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
