// A3 T9 conflict list page (design §10.2): groups, per-row buttons by concrete names, markers
// confirmation, footer (close hint, accept and finish, resolve in terminal).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConflictsPageView } from '../../../src/client/pages/ConflictsPage.tsx'
import type { ConflictsPageViewProps } from '../../../src/client/pages/ConflictsPage.tsx'
import { OVERLAY_LEVEL } from '../../../src/client/pages/workbench-overlay.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { OperationStateValue } from '../../../src/shared/protocol.ts'
import { enT, zhT } from '../i18n-helpers.tsx'
import { en, zh } from '../../../src/client/locales.ts'
import { conflictEntry, mergeState, pickState, rebaseState, stashPopState } from './operation-fixtures.ts'

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

describe('carry 4: conflicts from restoring the stash (operation null)', () => {
  it('lists the files with 当前分支 / 贮藏的改动, mark resolved works, no continue / abort / finish, stash kept note', () => {
    const html = view(stashPopState(), { onAbortRequest: noop })
    expect(html).toContain('data-conflict-row="src/a.ts"')
    expect(html).toContain('main（当前分支）')
    expect(html).toContain('采用 main')
    expect(html).toContain('采用 贮藏的改动')
    expect(html).toContain('标记已解决')
    expect(html).not.toContain('data-conflict-finish')
    expect(html).not.toContain('data-conflict-abort')
    expect(html).toContain(zh['conflict.stash.note'])
    expect(html).toContain('data-stash-note')
    expect(html).not.toContain(zh['conflict.closeHint'].slice(0, 8))
  })

  it('renders in English too', () => {
    const html = view(stashPopState(), { t: enT })
    expect(html).toContain(en['conflict.stash.note'])
    expect(html).toContain('main (current branch)')
    expect(html).toContain(en['conflict.stashLabel'])
  })
})

describe('carry 8: 中止… in the footer (confirmed, same wording as the banner)', () => {
  it('offers 中止… while an operation is in progress', () => {
    const html = view(mergeState(), { onAbortRequest: noop })
    expect(html).toMatch(/data-conflict-abort[^>]*>中止…|>中止…<\/button>/)
    expect(html).not.toContain('data-abort-confirm')
  })

  it('asks with the banner sentence before aborting', () => {
    const html = view(mergeState(), { onAbortRequest: noop, abortConfirming: true, onAbortCancel: noop, onAbort: noop })
    expect(html).toContain('data-abort-confirm')
    expect(html).toContain('会丢弃本次合并的进度，但保留工作区改动。')
    expect(html).toContain('中止合并')
    expect(html).toContain('data-conflict-abort-confirm')
  })
})

describe('B1 T6 entry to the merge window', () => {
  it('flag on: an unresolved file name opens the merge window; resolved rows do not', () => {
    const html = view(mergeState(), { onOpenFile: noop })
    expect(html).toMatch(/<button[^>]*data-merge-open="src\/a.ts"[^>]*>src\/a.ts<\/button>/)
    expect(html).toContain('data-merge-open="src/b.ts"')
    expect(html).not.toContain('data-merge-open="src/c.ts"')
  })

  it('flag off (no onOpenFile): the A3 row markup is unchanged', () => {
    const html = view(mergeState())
    expect(html).not.toContain('data-merge-open')
    expect(html).toMatch(/<span class="[^"]*" title="src\/a.ts">src\/a.ts<\/span>/)
  })
})

describe('B1 T7 conflict list enhancements (mergeWindow flag)', () => {
  type Merge = NonNullable<ConflictsPageViewProps['merge']>
  const merge = (over: Partial<Merge> = {}): Merge => ({
    groups: { unresolved: ['src/a.ts', 'src/b.ts'], resolved: ['src/c.ts'] },
    reviewed: new Set(['src/c.ts']),
    counts: new Map([['src/a.ts', { resolved: 1, total: 3 }], ['src/b.ts', null]]),
    selected: new Set(),
    simpleBusy: false,
    summary: null,
    menuPath: null,
    menuError: null,
    onSelect: noop,
    onManual: noop,
    onSimpleAll: noop,
    onOpenMenu: noop,
    onCloseMenu: noop,
    onUnresolve: noop,
    ...over,
  })

  it('shows 已解决块/总块 for counted files only', () => {
    const html = view(mergeState(), { onOpenFile: noop, merge: merge() })
    expect(html).toContain('1/3 已解决')
    expect(html.match(/data-chunk-count/g)).toHaveLength(1)
  })

  it('footer: 全部简单冲突 and 逐个解决 as the primary button; 接受并完成 is not primary', () => {
    const html = view(mergeState(), { onOpenFile: noop, merge: merge() })
    expect(html).toMatch(/<button[^>]*data-simple-all[^>]*>全部简单冲突<\/button>/)
    expect(html).toMatch(/<button[^>]*class="[^"]*primary[^"]*"[^>]*data-manual="resolveManually"[^>]*>逐个解决<\/button>/)
    expect(html).not.toMatch(/<button[^>]*class="[^"]*primary[^"]*"[^>]*data-conflict-finish/)
  })

  it('审查更改 when only unreviewed resolved files are left; the row is marked 未审查', () => {
    const value = mergeState({ conflicts: [], resolved: ['src/c.ts'] })
    const html = view(value, { merge: merge({ groups: { unresolved: [], resolved: ['src/c.ts'] }, reviewed: new Set() }) })
    expect(html).toMatch(/data-manual="reviewChanges"[^>]*>审查更改<\/button>/)
    expect(html).toContain('data-unreviewed')
    expect(html).toContain('未审查')
    // Review is optional: 接受并完成 stays enabled.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-conflict-finish/)
  })

  it('everything resolved and reviewed: no manual button, 所有冲突都已解决, 接受并完成 is primary', () => {
    const value = mergeState({ conflicts: [], resolved: ['src/c.ts'] })
    const html = view(value, { merge: merge({ groups: { unresolved: [], resolved: ['src/c.ts'] } }) })
    expect(html).not.toContain('data-manual')
    expect(html).toContain('所有冲突都已解决')
    expect(html).toMatch(/<button[^>]*class="[^"]*primary[^"]*"[^>]*data-conflict-finish/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-simple-all/)
  })

  it('selected rows are marked; the summary of 全部简单冲突 is shown', () => {
    const html = view(mergeState(), {
      onOpenFile: noop,
      merge: merge({ selected: new Set(['src/a.ts', 'src/c.ts']), summary: text('conflict.simpleAll.done', { resolved: 2, manual: 1 }) }),
    })
    const tag = (attr: string): string => html.match(new RegExp(`<li[^>]*${attr}[^>]*>`))?.[0] ?? ''
    expect(tag('data-conflict-row="src/a.ts"')).toContain('data-selected="true"')
    expect(tag('data-resolved-row="src/c.ts"')).toContain('data-selected="true"')
    expect(tag('data-conflict-row="src/b.ts"')).not.toContain('data-selected')
    expect(html).toContain('已解决 2 个文件，1 个文件需要手动处理')
  })

  it('a resolved row opens a menu with 还原冲突解决 (and shows its failure)', () => {
    const html = view(mergeState(), { merge: merge({ menuPath: 'src/c.ts', menuError: text('conflict.unresolve.terminal') }) })
    expect(html).toMatch(/role="menu"[^>]*aria-label="src\/c.ts 的操作"/)
    expect(html).toMatch(/role="menuitem"[^>]*data-unresolve="src\/c.ts"[^>]*>.*还原冲突解决/)
    expect(html).toContain('请在终端处理')
  })

  it('English rendering', () => {
    const html = view(mergeState(), { t: enT, onOpenFile: noop, merge: merge() })
    expect(html).toContain('1/3 resolved')
    expect(html).toContain('All Simple Conflicts')
    expect(html).toContain('Resolve Manually')
    expect(html).not.toMatch(/[一-鿿]/)
  })

  it('flag off (no merge props): none of it is rendered', () => {
    const html = view(mergeState())
    for (const marker of ['data-chunk-count', 'data-simple-all', 'data-manual', 'data-selected', 'data-unreviewed', 'role="menu"', '所有冲突都已解决']) {
      expect(html).not.toContain(marker)
    }
    expect(html).toMatch(/<button[^>]*class="[^"]*primary[^"]*"[^>]*data-conflict-finish/)
  })
})
