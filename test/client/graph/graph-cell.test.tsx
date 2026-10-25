// 提交图单元格：lane 溢出时的「+n」与被挤压节点的呈现（设计 §8.1.3）。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphCell, MAX_GRAPH_WIDTH } from '../../../src/client/graph/GraphCell.tsx'
import type { GraphRow } from '../../../src/client/graph/layout.ts'

function row(overrides: Partial<GraphRow> = {}): GraphRow {
  return { sha: 'a', lane: 0, colorId: 0, edges: [], width: 1, ...overrides }
}

describe('GraphCell 溢出', () => {
  it('没有溢出时不画 +n', () => {
    const html = renderToStaticMarkup(<GraphCell row={row()} />)
    expect(html).not.toContain('data-graph-overflow')
  })

  it('有隐藏 lane 时在行尾画 +n，且总宽不超过图形列上限', () => {
    const html = renderToStaticMarkup(<GraphCell row={row({ lane: 9, width: 10, overflow: 3 })} />)
    expect(html).toContain('data-graph-overflow="3"')
    expect(html).toContain('+3')
    const width = Number(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(html)?.[1])
    expect(width).toBeLessThanOrEqual(MAX_GRAPH_WIDTH)
  })

  it('被挤压到最后一条 lane 的节点带 clipped 标记', () => {
    const html = renderToStaticMarkup(<GraphCell row={row({ lane: 9, width: 10, clipped: true, overflow: 1 })} />)
    expect(html).toContain('data-graph-clipped="true"')
  })
})
