/**
 * 提交图配色：colorId → 色相序号 + 线型（设计 §15.3「色相源 + 主题混色」）。
 */
import { describe, expect, it } from 'vitest'

import {
  LANE_HUE_COUNT,
  LANE_PATTERN_COUNT,
  laneColor,
  laneHue,
  lanePattern,
} from '../../../src/client/graph/colors.ts'

describe('laneHue', () => {
  it('maps the first six colorIds to the six registered hues', () => {
    expect(range(0, LANE_HUE_COUNT).map(laneHue)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('reuses the hues from the seventh lane on', () => {
    expect(laneHue(LANE_HUE_COUNT)).toBe(1)
    expect(laneHue(LANE_HUE_COUNT * 2 - 1)).toBe(LANE_HUE_COUNT)
  })

  it('normalizes negative and fractional ids instead of producing invalid vars', () => {
    expect(laneHue(-1)).toBe(LANE_HUE_COUNT)
    expect(laneHue(2.7)).toBe(3)
  })
})

describe('lanePattern', () => {
  it('keeps the first six lanes solid', () => {
    expect(range(0, LANE_HUE_COUNT).map(lanePattern)).toEqual(Array.from({ length: 6 }, () => 'solid'))
  })

  it('differentiates beyond the hue budget with dashed and dotted', () => {
    expect(lanePattern(LANE_HUE_COUNT)).toBe('dashed')
    expect(lanePattern(LANE_HUE_COUNT * 2)).toBe('dotted')
  })

  it('wraps after the full hue × pattern grid', () => {
    expect(lanePattern(0)).toBe('solid')
    expect(lanePattern(LANE_HUE_COUNT * LANE_PATTERN_COUNT)).toBe('solid')
  })
})

describe('laneColor', () => {
  it('returns a css var reference, never a literal color', () => {
    expect(laneColor(0)).toBe('var(--git-lane-1)')
    expect(laneColor(LANE_HUE_COUNT + 2)).toBe('var(--git-lane-3)')
    expect(laneColor(0)).not.toMatch(/#|rgb|hsl/)
  })
})

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + start)
}
