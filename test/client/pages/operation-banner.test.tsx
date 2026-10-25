// T7 操作横幅：merge/rebase/cherry-pick/revert/bisect 的文案与冲突数；A1 只提供「查看控制台」。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { bannerFromStatus, OPERATION_LABEL, OperationBanner } from '../../../src/client/pages/OperationBanner.tsx'
import type { BannerOperation } from '../../../src/client/pages/OperationBanner.tsx'
import { statusFixture } from './branch-fixtures.ts'

const render = (operation: BannerOperation | null, conflicts = 0, branch: string | null = 'main'): string =>
  renderToStaticMarkup(<OperationBanner operation={operation} conflicts={conflicts} branch={branch} onOpenConsole={() => {}} />)

describe('OperationBanner', () => {
  it('没有进行中的操作时不渲染', () => {
    expect(render(null)).toBe('')
  })

  it.each([
    ['merge', '正在合并'],
    ['rebase', '正在变基'],
    ['cherry-pick', '正在拣选'],
    ['revert', '正在回滚'],
    ['bisect', '正在二分'],
  ] as const)('%s 显示「%s」', (operation, text) => {
    const html = render(operation)
    expect(html).toContain(`data-operation="${operation}"`)
    expect(html).toContain(text)
    expect(html).toContain('role="status"')
    expect(OPERATION_LABEL[operation]).toBeTruthy()
  })

  it('有冲突时显示冲突数并用警示语气', () => {
    const html = render('merge', 2)
    expect(html).toContain('2 个冲突')
    expect(html).toContain('data-conflicts="2"')
  })

  it('无冲突时不显示冲突数', () => {
    expect(render('rebase', 0)).not.toContain('个冲突')
  })

  it('显示目标分支；detached 时省略', () => {
    expect(render('rebase', 0, 'main')).toContain('main')
    expect(render('rebase', 0, null)).not.toContain('→')
  })

  it('A1 只读：只有「查看控制台」，没有继续/中止/解决冲突', () => {
    const html = render('rebase', 1)
    expect(html).toContain('查看控制台')
    for (const write of ['继续', '中止', '跳过', '解决冲突']) expect(html).not.toContain(`>${write}`)
  })

  it('不传 onOpenConsole 时不显示按钮', () => {
    const html = renderToStaticMarkup(<OperationBanner operation="merge" conflicts={0} />)
    expect(html).not.toContain('查看控制台')
  })
})

describe('bannerFromStatus', () => {
  it('从 StatusValue 取操作、冲突数与分支', () => {
    expect(bannerFromStatus(null)).toEqual({ operation: null, conflicts: 0, branch: null })
    expect(bannerFromStatus(statusFixture({ operation: 'merge', conflicts: [{ path: 'a', status: 'U' }] })))
      .toEqual({ operation: 'merge', conflicts: 1, branch: 'main' })
  })
})
