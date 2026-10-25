/**
 * 提交图配色（设计 §15.3）：DSH 主题没有分类色板，只有六个静态色系，
 * 所以颜色 = 「色相序号（1..6）+ 线型（实线/虚线/点线）」。
 * 第 7 条线起复用色相，用线型区分，不引入新的未登记色板。
 *
 * `colorId` 在 lane 创建时分配并跟随该条线移动（不随滚动或 lane 压缩变化），
 * 因此这里只做纯映射，不持有状态。
 */

/** 可用色相数量：`--git-lane-1` … `--git-lane-6`（定义在 `graph.module.css`）。 */
export const LANE_HUE_COUNT = 6

/** 线型数量：实线 / 虚线 / 点线。 */
export const LANE_PATTERN_COUNT = 3

export type LanePattern = 'solid' | 'dashed' | 'dotted'

const PATTERNS: readonly LanePattern[] = ['solid', 'dashed', 'dotted']

/** `colorId` → 1..6 的色相序号（对应 CSS 变量 `--git-lane-<n>`）。 */
export function laneHue(colorId: number): number {
  return normalize(colorId) % LANE_HUE_COUNT + 1
}

/** `colorId` → 线型；同一色相的第 2、3 轮分别用虚线、点线。 */
export function lanePattern(colorId: number): LanePattern {
  const variant = Math.floor(normalize(colorId) / LANE_HUE_COUNT) % LANE_PATTERN_COUNT
  return PATTERNS[variant] ?? 'solid'
}

/** `colorId` → 可直接写进 `stroke` 的 CSS 变量引用（绝不返回字面色值）。 */
export function laneColor(colorId: number): string {
  return `var(--git-lane-${laneHue(colorId)})`
}

/** 选中态加粗到 2.5px（设计 §15.3 对比度要求），其余 1.6px。 */
export function laneStrokeWidth(selected: boolean): number {
  return selected ? 2.5 : 1.6
}

function normalize(colorId: number): number {
  if (!Number.isFinite(colorId)) return 0
  const truncated = Math.trunc(colorId)
  return ((truncated % (LANE_HUE_COUNT * LANE_PATTERN_COUNT)) + LANE_HUE_COUNT * LANE_PATTERN_COUNT) %
    (LANE_HUE_COUNT * LANE_PATTERN_COUNT)
}
