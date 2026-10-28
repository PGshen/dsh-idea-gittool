/**
 * 增量提交图布局（设计 §8.1.3「Graph 算法要点」，纯函数、不依赖 DOM）。
 *
 * 服务端只返回提交行（sha/parents/元数据），图形在客户端增量计算：
 * - `append` 只处理新到的一页，保留 lane 状态，不重算已渲染行（AC5）；
 * - 颜色按 lane 创建顺序分配（`colorId`），随线移动，不随滚动变化；
 * - 父提交已知但还没加载 → `stub`（实线小尾巴，等下一页）；
 * - 历史到底（`hasMore: false`）仍没等到的父提交 → 就地改成 `dashed`（不在结果集里）。
 *
 * 筛选/排序变化时调用 `reset()` 后重放第一页。
 */

/** 提交图最多同时显示的 lane 数（视觉最多 6 色相 + 线型区分，见 colors.ts）。 */
export const DEFAULT_MAX_LANES = 10

/** 每格 lane 宽度（px，设计 §8.1.3：14px/lane）。 */
export const LANE_WIDTH = 14

/** 行高（px，设计 §8.1.3：26px）。 */
export const ROW_HEIGHT = 26

/** B4a compact mode row height (design §13). */
export const COMPACT_ROW_HEIGHT = 24

export type GraphEdgeKind = 'line' | 'curve' | 'stub' | 'dashed'

/**
 * 一行内的一段边。几何约定见行首注释：
 * `line` 贯穿整格；`curve` 上半格斜进节点；`stub`/`dashed` 从节点向下半格。
 */
export interface GraphEdge {
  fromLane: number
  toLane: number
  kind: GraphEdgeKind
  /**
   * 这段线的颜色 id（见 colors.ts）。取「线自己所属 lane 的颜色」：
   * 穿行的线用自己 lane 的颜色，节点发出的 stub 用节点 lane 的颜色，
   * 被吸收的合并父边用它进来时的颜色。渲染侧据此不必再维护 lane→色的表。
   */
  colorId: number
}

export interface GraphRow {
  sha: string
  /** 节点所在 lane。 */
  lane: number
  /** 该条线（lane）的颜色 id，见 colors.ts。 */
  colorId: number
  edges: GraphEdge[]
  /** 本行用到的 lane 数（含节点与所有边），用于决定图形列宽；不超过 maxLanes。 */
  width: number
  /** 本行之后仍在等待、但位于 maxLanes 之外（不渲染）的 lane 数；渲染为「+n」。 */
  overflow?: number
  /** 节点真实 lane 超出 maxLanes，被挤到最后一条可见 lane 上显示。 */
  clipped?: boolean
}

export interface GraphCommit {
  sha: string
  parents: readonly string[]
}

export type GraphOrder = 'date' | 'topo'

export interface GraphLayoutOptions {
  /** 提交顺序由 Host 决定；这里只记录，用于同一份历史的重建语义。 */
  order?: GraphOrder
  /** 只看第一父提交（`git log --first-parent`）。 */
  firstParent?: boolean
  /** 隐藏合并提交（`git log --no-merges`）；Host 已过滤，这里是兜底。 */
  noMerges?: boolean
  /** lane 上限，默认 {@link DEFAULT_MAX_LANES}。 */
  maxLanes?: number
}

export interface GraphAppendOptions {
  /**
   * 后面还有页吗（`LogValue.next` 存在即为 `true`）。默认 `true`：
   * 只有在确认历史到底时才把没等到的父提交画成虚线。
   */
  hasMore?: boolean
}

export interface GraphLayout {
  /** 追加一页提交，返回这一页新产生的行（不包含之前已经返回的行）。 */
  append(commits: readonly GraphCommit[], options?: GraphAppendOptions): GraphRow[]
  /** 清空 lane、行与颜色序列（筛选/排序变化时调用）。 */
  reset(): void
  readonly rows: readonly GraphRow[]
  /** 还在等父提交的 lane 数（诊断与测试用）。 */
  readonly pendingLanes: number
}

interface LaneState {
  /** 这个 lane 正在等哪个提交；`null` 表示空闲。 */
  sha: string | null
  /** 线的颜色 id，lane 创建时分配，跟随线而不是跟随下标。 */
  colorId: number
  /** 指向「等这个父提交」的那条 stub 边，历史到底时用来改成虚线。 */
  pending: { row: GraphRow; edge: GraphEdge } | null
}

export function createGraphLayout(options: GraphLayoutOptions = {}): GraphLayout {
  const maxLanes = Math.max(1, Math.trunc(options.maxLanes ?? DEFAULT_MAX_LANES))
  const firstParent = options.firstParent === true
  const noMerges = options.noMerges === true

  let lanes: LaneState[] = []
  let rows: GraphRow[] = []
  let nextColorId = 0

  function allocateColor(): number {
    const colorId = nextColorId
    nextColorId += 1
    return colorId
  }

  /** lane 复用：优先右边的空位（避免线交叉），其次左边的，最后才占用新 lane。 */
  function freeLaneAfter(reference: number): number {
    for (let index = reference + 1; index < lanes.length; index += 1) {
      if (lanes[index]?.sha === null) return index
    }
    for (let index = 0; index <= reference && index < lanes.length; index += 1) {
      if (lanes[index]?.sha === null) return index
    }
    // 记账不设上限：超过 maxLanes 的 lane 照常记录等待关系，只是不渲染（见 clampRow）。
    // 若把溢出挤到已有 lane 上，会覆盖别人的等待记录，导致丢边/断主线。
    lanes.push({ sha: null, colorId: -1, pending: null })
    return lanes.length - 1
  }

  /**
   * 把真实 lane 的行裁到可见范围（设计 §8.1.3：只显示前 maxLanes 条 + 「+n」）。
   * 两端都可见的边才保留；节点超出时挤到最后一条可见 lane 并标记 clipped。
   */
  function clampRow(row: GraphRow): GraphRow {
    const hidden = lanes.reduce((count, lane, index) => count + (index >= maxLanes && lane.sha !== null ? 1 : 0), 0)
    if (hidden > 0) row.overflow = hidden
    if (row.lane >= maxLanes) {
      row.lane = maxLanes - 1
      row.clipped = true
    }
    if (row.width > maxLanes) {
      // 原地过滤，保留边对象身份（finalizePendingLanes 会就地改 kind）。
      const visible = row.edges.filter((edge) => edge.fromLane < maxLanes && edge.toLane < maxLanes)
      row.edges.length = 0
      row.edges.push(...visible)
      row.width = maxLanes
    }
    return row
  }

  function layCommit(commit: GraphCommit, parents: readonly string[]): GraphRow {
    const activeAbove = lanes.map((lane) => lane.sha !== null)

    let commitLane = -1
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index]?.sha === commit.sha) {
        commitLane = index
        break
      }
    }
    if (commitLane === -1) {
      // 没有人在等它：这是一条新出现的头（另一个分支的顶端 / 无关历史）。
      commitLane = freeLaneAfter(-1)
      lanes[commitLane] = { sha: commit.sha, colorId: allocateColor(), pending: null }
    }

    const colorId = lanes[commitLane]?.colorId ?? 0
    const row: GraphRow = { sha: commit.sha, lane: commitLane, colorId, edges: [], width: 1 }
    const edges = row.edges
    let widest = commitLane

    // 1. 其它正在等这个提交的 lane 都是合并进来的父边：上半格斜入节点，然后释放。
    for (let index = 0; index < lanes.length; index += 1) {
      if (index === commitLane) continue
      if (lanes[index]?.sha !== commit.sha) continue
      edges.push({ fromLane: index, toLane: commitLane, kind: 'curve', colorId: lanes[index]?.colorId ?? colorId })
      widest = Math.max(widest, index)
      lanes[index] = { sha: null, colorId: -1, pending: null }
    }

    // 2. 父提交占位：第一父沿用本 lane，其余父各开一条新线。
    const parentEdges: { target: number; edge: GraphEdge }[] = []
    for (let index = 0; index < parents.length; index += 1) {
      const parentSha = parents[index]
      if (parentSha === undefined) continue
      const target = index === 0 ? commitLane : freeLaneAfter(commitLane)
      lanes[target] = { sha: parentSha, colorId: index === 0 ? colorId : allocateColor(), pending: null }
      const edge: GraphEdge = index === 0 && activeAbove[commitLane] === true
        ? { fromLane: commitLane, toLane: commitLane, kind: 'line', colorId }
        : { fromLane: commitLane, toLane: target, kind: 'stub', colorId: lanes[target]?.colorId ?? colorId }
      edges.push(edge)
      parentEdges.push({ target, edge })
      widest = Math.max(widest, target)
    }
    if (parents.length === 0) {
      // 根提交：主线到节点为止，不再往下延伸；无论上方有没有线，lane 都要释放，
      // 否则孤立的根提交会永久占住一条 lane。
      // 用同 lane 的 `curve`（上半格竖直进节点），不用贯穿整格的 `line`，节点下方不留线头。
      if (activeAbove[commitLane] === true) {
        edges.push({ fromLane: commitLane, toLane: commitLane, kind: 'curve', colorId })
      }
      lanes[commitLane] = { sha: null, colorId: -1, pending: null }
    }

    // 3. 其它仍在等待的 lane 直接穿过本行。
    for (let index = 0; index < lanes.length; index += 1) {
      if (index === commitLane) continue
      if (activeAbove[index] !== true) continue
      if (lanes[index]?.sha === null || lanes[index]?.sha === undefined) continue
      edges.push({ fromLane: index, toLane: index, kind: 'line', colorId: lanes[index]?.colorId ?? 0 })
      widest = Math.max(widest, index)
    }

    // 边顺序固定（按 fromLane 再按 toLane），方便渲染与断言。
    edges.sort((left, right) => left.fromLane - right.fromLane || left.toLane - right.toLane)
    row.width = widest + 1

    // 只有 stub 需要在「历史到底」时变成虚线；line 表示这条线从上面连着来。
    for (const { target, edge } of parentEdges) {
      const lane = lanes[target]
      if (lane !== undefined && lane.pending === null && edge.kind === 'stub') {
        lane.pending = { row, edge }
      }
    }

    return clampRow(row)
  }

  function finalizePendingLanes(): void {
    for (const lane of lanes) {
      const pending = lane.pending
      if (pending === null) continue
      pending.edge.kind = 'dashed'
      lane.pending = null
    }
  }

  return {
    append(commits, appendOptions = {}) {
      const hasMore = appendOptions.hasMore !== false
      const appended: GraphRow[] = []
      for (const commit of commits) {
        // noMerges 是兜底（Host 已过滤）：合并提交仍出一行、只连第一父，
        // 不能跳过——调用方按下标把 rows 与 commits 对齐。
        const parents = (firstParent || noMerges ? commit.parents.slice(0, 1) : commit.parents)
          .filter((parent) => parent !== commit.sha)
        const row = layCommit(commit, parents)
        rows.push(row)
        appended.push(row)
      }
      if (!hasMore) finalizePendingLanes()
      return appended
    },
    reset() {
      lanes = []
      rows = []
      nextColorId = 0
    },
    get rows() {
      return rows
    },
    get pendingLanes() {
      return lanes.reduce((count, lane) => (lane.pending === null ? count : count + 1), 0)
    },
  }
}
