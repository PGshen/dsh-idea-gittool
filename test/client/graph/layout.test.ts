/**
 * 增量提交图布局（设计 §8.1.3「Graph 算法要点」）。
 *
 * 行内边的几何约定（渲染侧据此画 26px 高的 SVG 单元格）：
 * - `line`   在 fromLane 上贯穿整格：上一行连到下一行；
 * - `curve`  上半格从 fromLane 斜进节点（toLane === 行节点 lane）：被吸收的合并父边，
 *            或同 lane 竖直进节点后终止（根提交）；
 * - `stub`   从节点向下半格到 toLane（fromLane === 行节点 lane）：本行新开的父边；
 * - `dashed` 与 stub 同几何但虚线：该父提交不在结果集里（历史已到底 / 被过滤）。
 */
import { describe, expect, it } from 'vitest'

import { createGraphLayout } from '../../../src/client/graph/layout.ts'
import type { GraphCommit, GraphEdge, GraphEdgeKind, GraphRow } from '../../../src/client/graph/layout.ts'

describe('linear history', () => {
  it('keeps one lane and continues it with a solid line', () => {
    const layout = createGraphLayout()
    const rows = layout.append([c('a', 'b'), c('b', 'c'), c('c')], { hasMore: false })

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1])
    expect(rows.map((row) => row.colorId)).toEqual([0, 0, 0])
    expect(rows[0]?.edges).toEqual([e(0, 0, 'stub', 0)])
    expect(rows[1]?.edges).toEqual([e(0, 0, 'line', 0)])
    expect(rows[2]?.edges).toEqual([e(0, 0, 'curve', 0)])
  })

  it('exposes the same rows through the layout object', () => {
    const layout = createGraphLayout()
    layout.append([c('a', 'b'), c('b')], { hasMore: false })
    expect(layout.rows.map((row) => row.sha)).toEqual(['a', 'b'])
    expect(layout.pendingLanes).toBe(0)
  })
})

describe('merge commit', () => {
  it('opens a lane for the second parent and collapses it again', () => {
    const layout = createGraphLayout()
    const rows = layout.append([c('a', 'b', 'c'), c('b', 'd'), c('c', 'd'), c('d')], { hasMore: false })
    const bySha = index(rows)

    expect(bySha.a?.lane).toBe(0)
    expect(bySha.a?.width).toBe(2)
    expect(bySha.a?.edges).toEqual([e(0, 0, 'stub', 0), e(0, 1, 'stub', 1)])

    expect(bySha.b?.lane).toBe(0)
    expect(bySha.b?.edges).toEqual([e(0, 0, 'line', 0), e(1, 1, 'line', 1)])

    expect(bySha.c?.lane).toBe(1)
    expect(bySha.c?.edges).toEqual([e(0, 0, 'line', 0), e(1, 1, 'line', 1)])

    expect(bySha.d?.lane).toBe(0)
    expect(bySha.d?.edges).toEqual([e(0, 0, 'curve', 0), e(1, 0, 'curve', 1)])
    expect(bySha.d?.width).toBe(2)
  })
})

describe('octopus merge', () => {
  it('opens one lane per additional parent', () => {
    const layout = createGraphLayout()
    const rows = layout.append([c('a', 'b', 'c', 'd')], { hasMore: true })
    expect(rows[0]?.width).toBe(3)
    expect(rows[0]?.edges).toEqual([e(0, 0, 'stub', 0), e(0, 1, 'stub', 1), e(0, 2, 'stub', 2)])
  })
})

describe('interleaved independent histories', () => {
  it('keeps two heads on parallel lanes with distinct colors', () => {
    const layout = createGraphLayout()
    const rows = layout.append(
      [c('x1', 'x2'), c('y1', 'y2'), c('x2'), c('y2')],
      { hasMore: false },
    )
    const bySha = index(rows)

    expect(bySha.x1?.lane).toBe(0)
    expect(bySha.y1?.lane).toBe(1)
    expect(bySha.y1?.colorId).not.toBe(bySha.x1?.colorId)
    expect(bySha.y1?.edges).toEqual([e(0, 0, 'line', 0), e(1, 1, 'stub', 1)])

    expect(bySha.x2?.lane).toBe(0)
    expect(bySha.x2?.edges).toEqual([e(0, 0, 'curve', 0), e(1, 1, 'line', 1)])
    expect(bySha.y2?.lane).toBe(1)
    expect(bySha.y2?.width).toBe(2)
  })
})

describe('unrelated histories', () => {
  it('reuses lane 0 after a history ends at its root', () => {
    const layout = createGraphLayout()
    // 两段无关历史前后相接：x 链到根后，y 链重新从 lane 0 开始，换新颜色。
    const rows = layout.append([c('x1', 'x2'), c('x2'), c('y1', 'y2'), c('y2')], { hasMore: false })
    const bySha = index(rows)
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0, 0])
    expect(bySha.y1?.colorId).not.toBe(bySha.x1?.colorId)
    expect(bySha.x2?.edges).toEqual([e(0, 0, 'curve', 0)])
    expect(bySha.y1?.edges).toEqual([e(0, 0, 'stub', 1)])
    expect(layout.pendingLanes).toBe(0)
  })

  it('does not leak a lane for a lone parentless commit', () => {
    const layout = createGraphLayout()
    const rows = layout.append([c('orphan'), c('a', 'b'), c('b')], { hasMore: false })
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows[0]?.edges).toEqual([])
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1])
  })

  it('crosses a second head over a still-open lane', () => {
    const layout = createGraphLayout()
    // a 等 c；b 是另一条头，穿过 lane 0 的线，在 lane 1 结束。
    const rows = layout.append([c('a', 'c'), c('b'), c('c')], { hasMore: false })
    const bySha = index(rows)
    expect(bySha.b?.lane).toBe(1)
    expect(bySha.b?.edges).toEqual([e(0, 0, 'line', 0)])
    expect(bySha.c?.lane).toBe(0)
    expect(bySha.c?.width).toBe(1)
  })
})

describe('crossing fork', () => {
  it('merges a feature lane that forked off the mainline', () => {
    const layout = createGraphLayout()
    // main: m1 → m2；feature 从 m1 分叉（f1），最后由 m3 合入。
    const rows = layout.append(
      [c('m3', 'm2', 'f1'), c('m2', 'm1'), c('f1', 'm1'), c('m1')],
      { hasMore: false },
    )
    const bySha = index(rows)

    expect(bySha.m3?.edges).toEqual([e(0, 0, 'stub', 0), e(0, 1, 'stub', 1)])
    expect(bySha.f1?.lane).toBe(1)
    expect(bySha.m1?.lane).toBe(0)
    expect(bySha.m1?.edges).toEqual([e(0, 0, 'curve', 0), e(1, 0, 'curve', 1)])
    // 分叉后两条线各自占一格，颜色不同。
    expect(bySha.f1?.colorId).not.toBe(bySha.m2?.colorId)
  })
})

describe('graph options', () => {
  it('follows only the first parent', () => {
    const layout = createGraphLayout({ firstParent: true })
    const rows = layout.append([c('a', 'b', 'c'), c('b', 'c'), c('c')], { hasMore: false })
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
  })

  it('draws merge commits as first-parent only when noMerges is on (Host filters them; rows stay aligned)', () => {
    const layout = createGraphLayout({ noMerges: true })
    const rows = layout.append([c('a', 'b', 'c'), c('b', 'd'), c('c', 'd'), c('d')], { hasMore: false })
    expect(rows.map((row) => row.sha)).toEqual(['a', 'b', 'c', 'd'])
    expect(rows.every((row) => row.width <= 2)).toBe(true)
  })

  it('lays out only first-parent lanes across pages', () => {
    const layout = createGraphLayout({ firstParent: true })
    layout.append([c('a', 'b', 'x')], { hasMore: true })
    const second = layout.append([c('b', 'c'), c('c')], { hasMore: false })
    expect(layout.rows.every((row) => row.width === 1)).toBe(true)
    expect(second[0]?.edges).toEqual([e(0, 0, 'line', 0)])
    expect(layout.pendingLanes).toBe(0)
  })

  it('accepts a topo order without changing the lane output', () => {
    const date = createGraphLayout({ order: 'date' })
    const topo = createGraphLayout({ order: 'topo' })
    const commits = [c('a', 'b'), c('b')]
    expect(topo.append(commits, { hasMore: false })).toEqual(date.append(commits, { hasMore: false }))
  })
})

describe('pagination', () => {
  it('appends rows without recomputing rows already emitted', () => {
    const layout = createGraphLayout()
    const first = layout.append([c('a', 'b'), c('b', 'c')], { hasMore: true })
    const snapshot = structuredClone(first)

    const second = layout.append([c('c')], { hasMore: false })

    expect(first).toEqual(snapshot)
    expect(second.map((row) => row.sha)).toEqual(['c'])
    expect(layout.rows.map((row) => row.sha)).toEqual(['a', 'b', 'c'])
  })

  it('turns a still-pending stub into a dashed edge once history ends', () => {
    const layout = createGraphLayout()
    const first = layout.append([c('a', 'missing')], { hasMore: true })
    expect(first[0]?.edges).toEqual([e(0, 0, 'stub', 0)])
    expect(layout.pendingLanes).toBe(1)

    layout.append([c('other')], { hasMore: false })

    // 只就地改仍有小尾巴的那一行，不重算其它行。
    expect(layout.rows[0]?.edges).toEqual([e(0, 0, 'dashed', 0)])
    expect(layout.pendingLanes).toBe(0)
  })
})

describe('stable colors', () => {
  it('keeps colorIds of a lane stable across pages', () => {
    const layout = createGraphLayout()
    const first = layout.append([c('m3', 'm2', 'f1'), c('m2', 'm1')], { hasMore: true })
    const second = layout.append([c('f1', 'm1'), c('m1')], { hasMore: false })
    expect(first[0]?.colorId).toBe(0)
    // f1 沿用 m3 为它开出的那条线的颜色。
    expect(second[0]?.colorId).toBe(first[0]?.edges.find((edge) => edge.toLane === 1)?.colorId)
    expect(second[1]?.colorId).toBe(0)
  })

  it('rebuilds identically after reset (filter change replays the first page)', () => {
    const commits = [c('a', 'b', 'c'), c('b', 'd'), c('c', 'd'), c('d')]
    const layout = createGraphLayout()
    const before = structuredClone(layout.append(commits, { hasMore: false }))
    layout.reset()
    expect(layout.append(commits, { hasMore: false })).toEqual(before)
  })
})

describe('lane budget', () => {
  it('never exceeds ten lanes even with more concurrent heads', () => {
    const layout = createGraphLayout()
    const commits: GraphCommit[] = Array.from({ length: 12 }, (_, index) => c(`h${index}`, `p${index}`))
    const rows = layout.append(commits, { hasMore: true })
    expect(rows.every((row) => row.width <= 10)).toBe(true)
    expect(Math.max(...rows.map((row) => row.width))).toBe(10)
  })
})

describe('reset', () => {
  it('clears rows, lanes and the color sequence', () => {
    const layout = createGraphLayout()
    layout.append([c('a', 'b')], { hasMore: true })
    layout.reset()
    expect(layout.rows).toEqual([])
    expect(layout.pendingLanes).toBe(0)

    const rows = layout.append([c('a', 'b')], { hasMore: true })
    expect(rows[0]?.lane).toBe(0)
    expect(rows[0]?.colorId).toBe(0)
  })
})

describe('performance', () => {
  it('lays out 2000 branchy rows in under 50ms', () => {
    const layout = createGraphLayout()
    // 每 10 个提交一次合并：主线 + 一条短 feature 线，接近真实仓库形状。
    const commits: GraphCommit[] = []
    for (let i = 0; i < 2000; i += 1) {
      if (i % 10 === 0) commits.push(c(`s${i}`, `s${i + 1}`, `f${i}`))
      else if (i % 10 === 1) commits.push(c(`f${i - 1}`, `s${i + 1}`))
      else commits.push(c(`s${i}`, `s${i + 1}`))
    }
    const started = performance.now()
    for (let offset = 0; offset < commits.length; offset += 100) {
      layout.append(commits.slice(offset, offset + 100), { hasMore: true })
    }
    const elapsed = performance.now() - started
    expect(layout.rows).toHaveLength(2000)
    expect(elapsed).toBeLessThan(50)
  })

  it('lays out 2000 rows in well under 50ms', () => {
    const layout = createGraphLayout()
    const commits: GraphCommit[] = Array.from({ length: 2000 }, (_, i) => c(`s${i}`, `s${i + 1}`))

    const started = performance.now()
    const rows = layout.append(commits, { hasMore: true })
    const elapsed = performance.now() - started

    expect(rows).toHaveLength(2000)
    expect(elapsed).toBeLessThan(50)
  })
})

function c(sha: string, ...parents: string[]): GraphCommit {
  return { sha, parents }
}

function e(fromLane: number, toLane: number, kind: GraphEdgeKind, colorId: number): GraphEdge {
  return { fromLane, toLane, kind, colorId }
}

function index(rows: readonly GraphRow[]): Record<string, GraphRow | undefined> {
  const bySha: Record<string, GraphRow | undefined> = {}
  for (const row of rows) bySha[row.sha] = row
  return bySha
}

describe('lane 溢出（> maxLanes）', () => {
  /** 12 个并行头 h0..h11，各自的父 p0..p11 在所有头之后才出现。 */
  function parallelHeads(count: number): GraphCommit[] {
    const heads = Array.from({ length: count }, (_, i) => ({ sha: `h${i}`, parents: [`p${i}`] }))
    const parents = Array.from({ length: count }, (_, i) => ({ sha: `p${i}`, parents: [] }))
    return [...heads, ...parents]
  }

  it('节点 lane 始终落在 [0, maxLanes) 内，超出的行标记 clipped 与 overflow', () => {
    const layout = createGraphLayout({ maxLanes: 10 })
    const rows = layout.append(parallelHeads(12), { hasMore: false })

    for (const row of rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0)
      expect(row.lane).toBeLessThan(10)
      expect(row.width).toBeLessThanOrEqual(10)
      for (const edge of row.edges) {
        expect(edge.fromLane).toBeGreaterThanOrEqual(0)
        expect(edge.fromLane).toBeLessThan(10)
        expect(edge.toLane).toBeGreaterThanOrEqual(0)
        expect(edge.toLane).toBeLessThan(10)
      }
    }
    const h11 = rows.find((row) => row.sha === 'h11')
    expect(h11?.clipped).toBe(true)
    expect(h11?.overflow).toBe(2)
    expect(rows.find((row) => row.sha === 'h0')?.clipped).toBeUndefined()
  })

  it('溢出不会吞掉其它头的等待：每个可见父提交都由一条线连到', () => {
    const layout = createGraphLayout({ maxLanes: 10 })
    const rows = layout.append(parallelHeads(12), { hasMore: false })

    // p0..p9 在可见 lane 上，且是被上方的线接住的（有 curve 进入或贯穿的 line），不是孤立新头。
    for (let i = 0; i < 10; i += 1) {
      const row = rows.find((candidate) => candidate.sha === `p${i}`)
      expect(row?.clipped).toBeUndefined()
      expect(row?.edges.some((edge) => edge.toLane === row.lane && edge.kind !== 'dashed')).toBe(true)
    }
    // 所有父都被等到：没有残留的等待 lane。
    expect(layout.pendingLanes).toBe(0)
  })

  it('溢出时遇到合并提交，主线（第一父）不被第二父覆盖', () => {
    const layout = createGraphLayout({ maxLanes: 2 })
    const rows = layout.append([
      { sha: 'a', parents: ['m'] },
      { sha: 'b', parents: ['x'] },
      { sha: 'm', parents: ['main1', 'side1'] },
      { sha: 'x', parents: [] },
      { sha: 'main1', parents: [] },
      { sha: 'side1', parents: [] },
    ], { hasMore: false })

    const merge = rows.find((row) => row.sha === 'm')
    const main1 = rows.find((row) => row.sha === 'main1')
    expect(main1?.lane).toBe(merge?.lane)
    // main1 是被主线接住的，不是新开的头。
    expect(main1?.edges.some((edge) => edge.fromLane === main1.lane && edge.toLane === main1.lane)).toBe(true)
    expect(layout.pendingLanes).toBe(0)
  })
})

describe('noMerges 兜底保持行对齐', () => {
  it('合并提交仍产出一行（只连第一父），rows 与输入一一对应', () => {
    const layout = createGraphLayout({ noMerges: true })
    const input = [
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'a', parents: [] },
    ]
    const rows = layout.append(input, { hasMore: false })
    expect(rows.map((row) => row.sha)).toEqual(['m', 'a'])
    expect(rows[0]?.edges.filter((edge) => edge.kind !== 'line')).toHaveLength(1)
  })
})
