// A3 T9 conflict list page (design §10.2): groups, per-row buttons by concrete names, markers
// confirmation, footer (close hint, accept and finish, resolve in terminal).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConflictsPageView } from '../../../src/client/pages/ConflictsPage.tsx'
import type { ConflictsPageViewProps } from '../../../src/client/pages/ConflictsPage.tsx'
import { OVERLAY_LEVEL } from '../../../src/client/pages/workbench-overlay.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { OperationStateValue } from '../../../src/shared/protocol.ts'
import { zhT } from '../i18n-helpers.tsx'
import { conflictEntry, mergeState, pickState, rebaseState } from './operation-fixtures.ts'

const noop = (): void => {}

function view(value: OperationStateValue | null, extra: Partial<ConflictsPageViewProps> = {}): string {
  return renderToStaticMarkup(
    <ConflictsPageView
      t={zhT}
      state={{ status: value === null ? 'loading' : 'ready', value, error: null }}
      busyPath={null}
      markersPath={null}
      error={null}
      copied={false}
      finishBusy={false}
      onResolve={noop}
      onConfirmMarkers={noop}
      onCancelMarkers={noop}
      onClose={noop}
      onFinish={noop}
      onCopyCommand={noop}
      onRetry={noop}
      {...extra}
    />,
  )
}

describe('ConflictsPageView', () => {
  it('is a level-1 overlay page', () => {
    expect(OVERLAY_LEVEL.conflicts).toBe(1)
  })

  it('merge: two groups with counts; rows offer 采用 main / 采用 feature with ours/theirs tooltips', () => {
    const html = view(mergeState())
    expect(html).toContain('未解决 (2)')
    expect(html).toContain('已解决 (1)')
    expect(html).toContain('data-conflict-row="src/a.ts"')
    expect(html).toContain('data-resolved-row="src/c.ts"')
    expect(html).toContain('采用 main')
    expect(html).toContain('采用 feature')
    expect(html).toContain('main（当前分支）')
    expect(html).toContain('feature（被合并）')
    expect(html).toMatch(/title="[^"]*ours[^"]*"/)
    expect(html).toMatch(/title="[^"]*theirs[^"]*"/)
    expect(html).toContain('标记已解决')
  })

  it('rebase: target branch on the left, replayed commits on the right, with the ours note', () => {
    const html = view(rebaseState())
    expect(html).toContain('main（目标分支）')
    expect(html).toContain('feat/x 的提交')
    expect(html).toContain('采用 feat/x')
    expect(html).toContain('ours 是目标分支')
  })

  it('cherry-pick: the commit hash is the right side', () => {
    const html = view(pickState('cherry-pick'))
    expect(html).toContain('4abcdef（被拣选）')
    expect(html).toContain('采用 4abcdef')
  })

  it('DU / UD rows show keep / delete instead of the sides', () => {
    const html = view(mergeState({ conflicts: [conflictEntry('gone.ts', 'deleted-by-us'), conflictEntry('kept.ts', 'deleted-by-them')], resolved: [] }))
    expect(html).toContain('保留文件')
    expect(html).toContain('删除文件')
    expect(html).toContain('data-resolution="theirs"')
    expect(html).toContain('data-resolution="ours"')
    expect(html).toContain('data-resolution="delete"')
    expect(html).not.toContain('采用 main')
  })

  it('unresolved left: close shows a hint, accept-and-finish is disabled', () => {
    const html = view(mergeState())
    expect(html).toContain('data-close-hint')
    expect(html).toMatch(/disabled=""[^>]*data-conflict-finish|data-conflict-finish[^>]*disabled=""/)
    expect(html).toContain('在终端解决')
  })

  it('all resolved: accept-and-finish is enabled, no close hint', () => {
    const html = view(mergeState({ conflicts: [], resolved: ['src/a.ts'] }))
    expect(html).not.toContain('data-close-hint')
    expect(html).toMatch(/data-conflict-finish/)
    expect(html).not.toMatch(/disabled=""[^>]*data-conflict-finish|data-conflict-finish[^>]*disabled=""/)
    expect(html).toContain('接受并完成')
  })

  it('markers confirmation names the file and offers a forced mark', () => {
    const html = view(mergeState(), { markersPath: 'src/a.ts' })
    expect(html).toContain('data-markers-confirm')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('仍有冲突标记')
  })

  it('a busy row disables its buttons; errors and the copied state are shown', () => {
    const html = view(mergeState(), { busyPath: 'src/a.ts', error: text('write.error.git/locked'), copied: true })
    expect(html).toMatch(/data-conflict-row="src\/a.ts"[\s\S]*?disabled=""/)
    expect(html).toContain('role="alert"')
    expect(html).toContain('已复制')
  })

  it('loading and load error states', () => {
    expect(view(null)).toContain('aria-busy="true"')
    const html = renderToStaticMarkup(
      <ConflictsPageView
        t={zhT} state={{ status: 'error', value: null, error: { code: 'git/exec-failed', message: 'x' } }}
        busyPath={null} markersPath={null} error={null} copied={false} finishBusy={false}
        onResolve={noop} onConfirmMarkers={noop} onCancelMarkers={noop} onClose={noop} onFinish={noop} onCopyCommand={noop} onRetry={noop}
      />,
    )
    expect(html).toContain('data-conflict-retry')
  })
})
