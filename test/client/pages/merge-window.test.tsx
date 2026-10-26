// B1 T6 merge window markup (design §10.3; AC2 titles, AC4 buttons, AC8 fallback, AC11 questions):
// three panes named after the concrete sides (merge / rebase / cherry-pick), header and footer
// buttons, the apply and leave questions, read-only, the two-choice fallback, English rendering.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MergeWindowView, fallbackReason, mergeSideLabels } from '../../../src/client/pages/MergeWindow.tsx'
import type { MergeWindowHandlers, MergeWindowViewProps } from '../../../src/client/pages/MergeWindow.tsx'
import type { MergeWindowUi } from '../../../src/client/pages/merge-window-controller.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps, MergeStoreState } from '../../../src/client/store/merge-store.ts'
import type { MergeFileValue, MergeSide, OperationStateValue, RpcResult } from '../../../src/shared/protocol.ts'
import { enT, zhT } from '../i18n-helpers.tsx'
import { mergeState, pickState, rebaseState } from './operation-fixtures.ts'

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

const side = (body: string | null, blob: string, binary = false): MergeSide => ({ blob, text: body, binary, size: body?.length ?? 0 })

function file(over: Partial<MergeFileValue> = {}): MergeFileValue {
  return {
    path: 'src/a.ts',
    kind: 'both-modified',
    base: side('one\ntwo\nthree\nfour\n', '1'.repeat(40)),
    ours: side('one\nOURS\nthree\nfour\n', '2'.repeat(40)),
    theirs: side('one\nTHEIRS\nthree\nfour\nfive\n', '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: 'w'.repeat(40),
    draft: null,
    draftStale: false,
    resolved: false,
    ...over,
  }
}

async function loaded(value: MergeFileValue = file()): Promise<MergeStoreState> {
  const store = createMergeStore({
    loadFile: async () => ({ ok: true, value }) as RpcResult<MergeFileValue>,
    actions: { run: vi.fn() } as unknown as MergeStoreDeps['actions'],
  })
  await store.open(value.path)
  return store.getState()
}

const UI: MergeWindowUi = { currentChunk: null, confirm: null, notice: null, atEnd: null, applied: false }
const noop = (): void => {}
const handlers: MergeWindowHandlers = {
  onBack: noop,
  onPrevFile: noop,
  onNextFile: noop,
  onUndo: noop,
  onSaveClose: noop,
  onAction: noop,
  onToggleNonConflicting: noop,
  onApply: noop,
  onConfirmApply: noop,
  onCancelConfirm: noop,
  onLeaveAnswer: noop,
  onRetry: noop,
  onFallbackResolve: noop,
  onCopyCommand: noop,
}

function view(state: MergeStoreState, operation: OperationStateValue | null = mergeState(), extra: Partial<MergeWindowViewProps> = {}, t = zhT): string {
  return renderToStaticMarkup(
    <MergeWindowView
      t={t}
      path="src/a.ts"
      state={state}
      ui={UI}
      sides={mergeSideLabels(t, operation)}
      operation={operation}
      hasPrev={false}
      hasNext
      blockReason={null}
      nonConflictingOpen={false}
      fallback={{ busy: false, error: null, copied: false }}
      handlers={handlers}
      {...extra}
    />,
  )
}

describe('MergeWindowView: three panes and titles', () => {
  it('merge: left is the current branch (ours, :2:), right the merged branch (theirs, :3:)', async () => {
    const html = view(await loaded())
    expect(html).toContain('解决冲突：src/a.ts')
    expect(html).toContain('data-merge-pane="left"')
    expect(html).toContain('data-merge-pane="result"')
    expect(html).toContain('data-merge-pane="right"')
    expect(html).toContain('main（当前分支）')
    expect(html).toContain('feature（被合并）')
    expect(html).toContain('Result（可编辑）')
    expect(html).toMatch(/title="[^"]*Git 的 ours（:2:）/)
    expect(html).toMatch(/title="[^"]*Git 的 theirs（:3:）/)
    expect(html).not.toContain('data-rebase-note')
  })

  it('rebase: the target branch on the left, the replayed commits on the right, with the ours note', async () => {
    const html = view(await loaded(), rebaseState())
    expect(html).toContain('main（目标分支）')
    expect(html).toContain('feat/x 的提交')
    expect(html).toContain('data-rebase-note')
    expect(html).toContain('ours 是目标分支')
  })

  it('cherry-pick: the short hash is the right side', async () => {
    const html = view(await loaded(), pickState('cherry-pick'))
    expect(html).toContain('main（当前分支）')
    expect(html).toContain('4abcdef（被拣选）')
    expect(html).toContain('全部采用 4abcdef')
  })

  it('header: back, previous / next file, undo, save and close, resolved/total', async () => {
    const html = view(await loaded())
    expect(html).toContain('← 返回')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-merge-prev-file/)
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*data-merge-next-file/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-merge-undo/)
    expect(html).toContain('保存并关闭')
    expect(html).toContain('已解决 0/1')
  })

  it('footer: whole-file sides by name, non-conflicting menu, simple conflicts, revert, apply', async () => {
    const html = view(await loaded())
    expect(html).toContain('全部采用 main')
    expect(html).toContain('全部采用 feature')
    expect(html).toContain('应用非冲突更改')
    expect(html).toContain('解决简单冲突')
    expect(html).toContain('还原')
    expect(html).toMatch(/data-merge-apply[^>]*>应用更改</)
    expect(html).not.toContain('role="menu"')
    const open = view(await loaded(), mergeState(), { nonConflictingOpen: true })
    expect(open).toContain('role="menu"')
    expect(open).toContain('只应用 main 的')
    expect(open).toContain('只应用 feature 的')
    expect(open).toMatch(/data-non-conflicting="all"/)
  })
})

describe('MergeWindowView: questions and notices', () => {
  it('apply with unresolved chunks asks before writing', async () => {
    const html = view(await loaded(), mergeState(), { ui: { ...UI, confirm: { kind: 'apply', unresolved: 2 } } })
    expect(html).toContain('仍有 2 处未解决，按当前 Result 应用？')
    expect(html).toContain('仍然应用')
    expect(html).toContain('data-merge-apply-confirm')
  })

  it('leaving with unsaved changes asks save / discard / cancel', async () => {
    const html = view(await loaded(), mergeState(), { ui: { ...UI, confirm: { kind: 'leave', target: { kind: 'close' } } } })
    expect(html).toContain('有未保存的改动')
    expect(html).toContain('data-merge-leave="save"')
    expect(html).toContain('data-merge-leave="discard"')
    expect(html).toContain('data-merge-leave="cancel"')
  })

  it('shows notices, store errors and a discarded draft', async () => {
    const state = { ...(await loaded()), draftDiscarded: true, error: { key: 'merge.error.stale' as const } }
    const html = view(state, mergeState(), { ui: { ...UI, notice: { key: 'merge.simple.done', params: { count: 3 } } } })
    expect(html).toContain('已解决 3 处简单冲突')
    expect(html).toContain('文件已变化，请重新加载')
    expect(html).toContain('之前保存的草稿已作废')
  })

  it('read-only: save and apply are disabled with the reason', async () => {
    const html = view(await loaded(), mergeState(), { blockReason: 'RO' })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="RO"[^>]*data-merge-save/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="RO"[^>]*data-merge-apply/)
  })

  it('loading and load failure', () => {
    const base: MergeStoreState = { status: 'loading', path: 'src/a.ts', file: null, model: null, dirty: false, draftDiscarded: false, error: null, canUndo: false, canRedo: false }
    expect(view(base)).toContain('读取中…')
    const failed = view({ ...base, status: 'error', error: { key: 'merge.error.loadFailed', params: { code: 'git/exec-failed' } } })
    expect(failed).toContain('读取合并内容失败：git/exec-failed')
    expect(failed).toContain('data-merge-retry')
  })
})

describe('MergeWindowView: two-choice fallback (AC8)', () => {
  it('binary: explanation, the A3 row actions by name, resolve in terminal; no editors', async () => {
    const state = await loaded(file({ ours: side(null, '2'.repeat(40), true), theirs: side(null, '3'.repeat(40), true), base: side(null, '1'.repeat(40), true) }))
    expect(state.model).toBeNull()
    const html = view(state)
    expect(html).toContain('这是二进制文件')
    expect(html).toContain('采用 main')
    expect(html).toContain('采用 feature')
    expect(html).toContain('在终端解决')
    expect(html).not.toContain('data-merge-pane')
    expect(html).not.toContain('data-merge-apply')
  })

  it('delete kinds offer keep / delete', async () => {
    const state = await loaded(file({ kind: 'deleted-by-them', theirs: null }))
    const html = view(state)
    expect(html).toContain('一侧删除了这个文件')
    expect(html).toContain('保留文件')
    expect(html).toContain('删除文件')
  })

  it('fallbackReason table', () => {
    expect(fallbackReason(file({ tooLarge: true }))).toBe('merge.fallback.tooLarge')
    expect(fallbackReason(file({ kind: 'deleted-by-us', ours: null }))).toBe('merge.fallback.delete')
    expect(fallbackReason(file({ kind: 'both-deleted', ours: null, theirs: null }))).toBe('merge.fallback.delete')
    expect(fallbackReason(file({ ours: side(null, '2'.repeat(40), true) }))).toBe('merge.fallback.binary')
    expect(fallbackReason(file({ kind: 'added-by-us', theirs: null, base: null }))).toBe('merge.fallback.missing')
  })
})

describe('MergeWindowView: English', () => {
  it('renders without Chinese', async () => {
    const html = [
      view(await loaded(), mergeState(), { nonConflictingOpen: true, ui: { ...UI, confirm: { kind: 'apply', unresolved: 1 }, notice: { key: 'merge.nav.endNext' } } }, enT),
      view({ ...(await loaded()), draftDiscarded: true }, rebaseState(), { ui: { ...UI, confirm: { kind: 'leave', target: { kind: 'close' } } } }, enT),
      view(await loaded(file({ kind: 'deleted-by-them', theirs: null })), mergeState(), {}, enT),
      view(await loaded(), null, {}, enT),
    ].join('\n')
    expect(html).toContain('Resolve conflicts: src/a.ts')
    expect(html).toContain('Accept All from main')
    expect(CJK.test(html)).toBe(false)
  })
})
