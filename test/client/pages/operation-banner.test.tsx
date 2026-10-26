// T7 操作横幅：merge/rebase/cherry-pick/revert/bisect 的文案与冲突数；A1 只提供「查看控制台」。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { bannerFromStatus, OPERATION_LABEL, OperationBanner, OperationBannerView } from '../../../src/client/pages/OperationBanner.tsx'
import type { BannerOperation, OperationBannerViewProps } from '../../../src/client/pages/OperationBanner.tsx'
import { zhT } from '../i18n-helpers.tsx'
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
    expect(bannerFromStatus(null)).toEqual({ operation: null, conflicts: 0, branch: null, step: null })
    expect(bannerFromStatus(statusFixture({ operation: 'merge', conflicts: [{ path: 'a', status: 'U' }] })))
      .toEqual({ operation: 'merge', conflicts: 1, branch: 'main', step: null })
  })
})

describe('OperationBanner actions (A3 T9)', () => {
  const noop = (): void => {}
  const handlers = { onResolve: noop, onContinue: noop, onSkip: noop, onAbort: noop }
  const view = (props: Partial<OperationBannerViewProps> & Pick<OperationBannerViewProps, 'operation'>): string =>
    renderToStaticMarkup(
      <OperationBannerView t={zhT} conflicts={0} branch="main" confirmingAbort={false} onAbortRequest={noop} onAbortCancel={noop} {...handlers} {...props} />,
    )

  it.each([
    ['merge', false],
    ['rebase', true],
    ['cherry-pick', true],
    ['revert', false],
  ] as const)('%s: continue and abort; skip only for rebase / cherry-pick (%s)', (operation, skip) => {
    const html = view({ operation })
    expect(html).toContain('data-banner-action="continue"')
    expect(html).toContain('data-banner-action="abort"')
    expect(html.includes('data-banner-action="skip"')).toBe(skip)
    expect(html).not.toContain('请在终端完成或放弃该操作')
  })

  it('bisect has no write actions (only the console)', () => {
    const html = view({ operation: 'bisect', onOpenConsole: noop })
    expect(html).not.toContain('data-banner-action="continue"')
    expect(html).toContain('查看控制台')
  })

  it('conflicts: "解决冲突…" appears and continue is disabled with the count', () => {
    const html = view({ operation: 'merge', conflicts: 2 })
    expect(html).toContain('data-banner-action="resolve"')
    expect(html).toContain('解决冲突…')
    expect(html).toMatch(/disabled=""[^>]*data-banner-action="continue"|data-banner-action="continue"[^>]*disabled=""/)
    expect(html).toContain('还有 2 个冲突未解决')
    expect(view({ operation: 'merge' })).not.toContain('data-banner-action="resolve"')
  })

  it('rebase progress 2/5', () => {
    expect(view({ operation: 'rebase', step: { current: 2, total: 5 } })).toContain('2/5')
  })

  it('abort is a danger button that asks first: the confirmation names the operation', () => {
    expect(view({ operation: 'merge' })).toMatch(/data-banner-action="abort"[^>]*data-danger|data-danger[^>]*data-banner-action="abort"/)
    const html = view({ operation: 'rebase', confirmingAbort: true })
    expect(html).toContain('会丢弃本次变基的进度，但保留工作区改动')
    expect(html).toContain('data-banner-action="abort-confirm"')
    expect(html).toContain('data-banner-action="abort-cancel"')
  })

  it('pending stash note', () => {
    expect(view({ operation: 'merge', pendingStash: true })).toContain('完成或中止后会恢复贮藏的改动')
    expect(view({ operation: 'merge' })).not.toContain('恢复贮藏的改动')
  })

  it('read-only / busy disable the write buttons', () => {
    const blocked = view({ operation: 'rebase', blockReason: '只读' })
    expect(blocked).toMatch(/disabled=""[^>]*data-banner-action="skip"|data-banner-action="skip"[^>]*disabled=""/)
    expect(blocked).toContain('title="只读"')
    const busy = view({ operation: 'rebase', busy: true })
    expect(busy).toMatch(/disabled=""[^>]*data-banner-action="abort"|data-banner-action="abort"[^>]*disabled=""/)
  })
})

describe('bannerFromStatus (A3 T9)', () => {
  it('carries the rebase step', () => {
    expect(bannerFromStatus(statusFixture({ operation: 'rebase', operationStep: { current: 2, total: 5 } })))
      .toMatchObject({ operation: 'rebase', step: { current: 2, total: 5 } })
  })
})
