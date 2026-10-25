// 提交图单元格：把 GraphRow 画成 26px 高的单行 SVG（设计 §8.1.3）。
// 每行自带全部边段，虚拟列表按行复用，不依赖跨行状态。
import type { ReactNode } from 'react'
import { laneColor, lanePattern, laneStrokeWidth } from './colors.ts'
import type { GraphEdge, GraphRow } from './layout.ts'
import { LANE_WIDTH, ROW_HEIGHT } from './layout.ts'
import css from './graph.module.css'

/** 图形列的最大宽度（设计 §8.1.3：最大 160px）。 */
export const MAX_GRAPH_WIDTH = 160

export interface GraphCellProps {
  row: GraphRow
  /** 行高，默认 26px（与表格行高一致）。 */
  height?: number
  /** 每格 lane 宽度，默认 14px。 */
  laneWidth?: number
  /** 该提交是否指向 HEAD（空心环）。 */
  head?: boolean
  /** 该提交是否在当前分支上（外环）。 */
  current?: boolean
  /** 选中态加粗到 2.5px（设计 §15.3）。 */
  selected?: boolean
}

export function GraphCell({
  row,
  height = ROW_HEIGHT,
  laneWidth = LANE_WIDTH,
  head = false,
  current = false,
  selected = false,
}: GraphCellProps): ReactNode {
  const width = Math.min(MAX_GRAPH_WIDTH, Math.max(1, row.width) * laneWidth)
  const centerY = height / 2
  const nodeX = laneX(row.lane, laneWidth)

  return (
    <svg
      className={css.graph}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="presentation"
      data-graph-width={row.width}
      data-graph-lane={row.lane}
    >
      {row.edges.map((edge, index) => (
        <path
          key={`${edge.kind}-${edge.fromLane}-${edge.toLane}-${index}`}
          className={css.edge}
          d={edgePath(edge, height, laneWidth)}
          stroke={laneColor(edge.colorId)}
          strokeWidth={laneStrokeWidth(selected)}
          strokeDasharray={dashArray(edge)}
        />
      ))}
      {current ? (
        <circle className={css.currentRing} cx={nodeX} cy={centerY} r={6} />
      ) : null}
      <circle
        className={head ? css.headNode : css.node}
        cx={nodeX}
        cy={centerY}
        r={3.6}
        fill={head ? undefined : laneColor(row.colorId)}
      />
    </svg>
  )
}

/** lane 序号 → 该 lane 的中心 x 坐标。 */
export function laneX(lane: number, laneWidth: number = LANE_WIDTH): number {
  return lane * laneWidth + laneWidth / 2
}

/**
 * 单段边的路径。几何约定与 `layout.ts` 一致：
 * `line` 贯穿整格；`curve` 上半格斜进节点；`stub`/`dashed` 从节点向下半格。
 */
export function edgePath(edge: GraphEdge, height: number = ROW_HEIGHT, laneWidth: number = LANE_WIDTH): string {
  const fromX = laneX(edge.fromLane, laneWidth)
  const toX = laneX(edge.toLane, laneWidth)
  const centerY = height / 2
  if (edge.kind === 'line') {
    return `M ${fromX} 0 L ${fromX} ${height}`
  }
  if (edge.kind === 'curve') {
    return `M ${fromX} 0 Q ${fromX} ${centerY} ${toX} ${centerY}`
  }
  // stub / dashed：从节点向下，斜到父提交所在的 lane。
  if (fromX === toX) return `M ${fromX} ${centerY} L ${toX} ${height}`
  return `M ${fromX} ${centerY} Q ${fromX} ${centerY + (height - centerY) / 2} ${toX} ${height}`
}

/**
 * 虚线样式：`dashed` 边（父提交不在结果集）固定虚线；其余按 lane 的色相预算，
 * 第 7 条线起复用色相 + 线型区分（设计 §15.3）。
 */
export function dashArray(edge: GraphEdge): string | undefined {
  if (edge.kind === 'dashed') return '3 3'
  const pattern = lanePattern(edge.colorId)
  if (pattern === 'dashed') return '4 3'
  if (pattern === 'dotted') return '1.5 2.5'
  return undefined
}
