// B3a T5：交互式变基覆盖页（静态渲染、键盘判定、信息编辑目标、预览文本）。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  InteractiveRebasePageView,
  afterInteractiveRebase,
  presetIndex,
  displayTodo,
  messageTarget,
  rebaseKeyAction,
} from '../../../src/client/pages/InteractiveRebasePage.tsx'
import type { InteractiveRebasePageViewProps } from '../../../src/client/pages/InteractiveRebasePage.tsx'
import { MESSAGE_PLACEHOLDER, fromPlan, setAction } from '../../../src/client/rebase/rebase-model.ts'
import type { RebaseState } from '../../../src/client/store/rebase-store.ts'
import { text } from '../../../src/client/localized-text.ts'
import type { RebasePlanValue } from '../../../src/shared/protocol.ts'
import { enT, withLocale, zhT } from '../i18n-helpers.tsx'

const NOW = Date.parse('2026-10-27T12:00:00+08:00')
const noop = (): void => undefined
const sha = (letter: string): string => letter.repeat(40)

function plan(extra: Partial<RebasePlanValue> = {}): RebasePlanValue {
  return {
    base: sha('0'),
    head: sha('c'),
    branch: 'feature',
    commits: ['a', 'b', 'c'].map(letter => ({
      sha: sha(letter), shortSha: letter.repeat(7), parents: [], author: 'Alice', email: 'a@x',
      date: '2026-10-24T10:00:00+08:00', subject: `subject ${letter}`, message: `subject ${letter}\n\nbody`,
      pushed: letter === 'a', branches: letter === 'b' ? ['mid'] : [],
    })),
    supportsUpdateRefs: true,
    ...extra,
  }
}

function state(extra: Partial<RebaseState> = {}): RebaseState {
  const value = extra.plan ?? plan()
  return {
    base: sha('0'), status: 'ready', plan: value, rows: fromPlan(value), error: null, updateRefs: false,
    confirmPushed: false, rewritesPushed: false, invalid: text('rebase.invalid.unchanged'), submitting: false, ...extra,
  }
}

function render(given: RebaseState, extra: Partial<InteractiveRebasePageViewProps> = {}, t = zhT): string {
  const props: InteractiveRebasePageViewProps = {
    state: given, selected: 0, showPreview: false, failure: null, now: NOW,
    onBack: noop, onRetry: noop, onSelect: noop, onRows: noop, onUpdateRefs: noop, onConfirmPushed: noop,
    onTogglePreview: noop, onSubmit: noop, ...extra,
  }
  return renderToStaticMarkup(withLocale(<InteractiveRebasePageView {...props} />, t))
}

describe('InteractiveRebasePageView', () => {
  it('lists the commits oldest first with action, hash, subject, branch and pushed marks', () => {
    const html = render(state())
    expect(html).toContain('交互式变基：feature')
    expect(html).toContain('把 feature 上的 3 个提交重新应用到 0000000')
    expect(html.indexOf('subject a')).toBeLessThan(html.indexOf('subject c'))
    expect(html).toContain('aaaaaaa')
    expect(html).toContain('>mid<')
    expect(html).toContain('已推送')
    expect(html.match(/<option/g)?.length).toBe(18)
    expect(html).toContain('draggable="true"')
    expect(html).toContain('aria-selected="true"')
  })

  it('disables the submit button with the reason while the list is invalid', () => {
    const html = render(state())
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="没有任何改动"/)
    expect(html).toContain('没有任何改动')
    const ready = render(state({ invalid: null, rows: setAction(fromPlan(plan()), 2, 'drop') }))
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>开始变基/)
    expect(ready).toContain('开始变基')
  })

  it('asks to confirm rewriting pushed history and offers --update-refs when supported', () => {
    const html = render(state({ rewritesPushed: true, invalid: text('rebase.invalid.confirmPushed') }))
    expect(html).toContain('这会改写已推送的历史')
    expect(html).toContain('我了解这会改写已推送的历史')
    expect(html).toContain('--update-refs')
    expect(render(state({ plan: plan({ supportsUpdateRefs: false }) }))).not.toContain('--update-refs')
  })

  it('explains why other branches will not move on a git older than 2.38 (B4d T3)', () => {
    expect(render(state({ plan: plan({ supportsUpdateRefs: false }) }))).toContain('当前 Git 低于 2.38，变基不会移动指向这些提交的其他分支（mid）。')
    expect(render(state())).not.toContain('当前 Git 低于 2.38')
    const lonely = plan({ supportsUpdateRefs: false })
    lonely.commits = lonely.commits.map(commit => ({ ...commit, branches: [] }))
    expect(render(state({ plan: lonely }))).not.toContain('当前 Git 低于 2.38')
  })

  it('shows the message editor for a reword row and the todo preview with readable message lines', () => {
    const rows = setAction(fromPlan(plan()), 1, 'reword')
    const html = render(state({ rows, invalid: null }), { selected: 1, showPreview: true })
    expect(html).toContain('bbbbbbb 的提交信息')
    expect(html).toContain('subject b\n\nbody')
    expect(html).toContain('data-rebase-preview')
    expect(html).toContain(`pick ${sha('b')}`)
    expect(html).toContain('# 写回上面这组的提交信息')
    expect(html).not.toContain(MESSAGE_PLACEHOLDER.replace('<', '&lt;'))
  })

  it('explains a blocked range with a terminal command', () => {
    const html = render(state({ plan: plan({ blocked: 'merge-commit', commits: [] }), rows: [] }))
    expect(html).toContain('范围内有合并提交')
    expect(html).toContain(`git rebase -i ${sha('0')}`)
    expect(render(state({ plan: plan({ blocked: 'detached', commits: [] }), rows: [] }))).not.toContain('git rebase -i')
    expect(render(state({ plan: plan({ blocked: 'too-many', commits: [], base: null }), rows: [] }))).toContain('git rebase -i --root')
  })

  it('shows loading, error and failure states, and renders in English', () => {
    expect(render(state({ status: 'loading', plan: null, rows: [] }))).toContain('正在读取提交')
    expect(render(state({ status: 'error', plan: null, rows: [], error: { code: 'git/exec-failed', message: 'boom' } }))).toContain('boom')
    expect(render(state(), { failure: 'HEAD moved' })).toContain('变基失败：HEAD moved')
    expect(render(state(), {}, enT)).toContain('Interactive rebase: feature')
  })
})

describe('rebaseKeyAction', () => {
  const key = (value: string, extra: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; inField: boolean }> = {}) =>
    rebaseKeyAction({ key: value, altKey: false, ctrlKey: false, metaKey: false, inField: false, ...extra })

  it('selects with arrows, moves with Alt+arrows and switches actions with letters', () => {
    expect(key('ArrowDown')).toEqual({ kind: 'select', delta: 1 })
    expect(key('ArrowUp', { altKey: true })).toEqual({ kind: 'move', delta: -1 })
    expect(key('f')).toEqual({ kind: 'action', action: 'fixup' })
    expect(key('D')).toEqual({ kind: 'action', action: 'drop' })
  })

  it('leaves form fields, modifiers and other keys alone', () => {
    expect(key('p', { inField: true })).toBeNull()
    expect(key('ArrowDown', { inField: true })).toBeNull()
    expect(key('r', { ctrlKey: true })).toBeNull()
    expect(key('s', { altKey: true })).toBeNull()
    expect(key('x')).toBeNull()
  })
})

describe('messageTarget and displayTodo', () => {
  it('targets the group head of a squash member, nothing for plain picks or fixup-only groups', () => {
    const rows = setAction(fromPlan(plan()), 1, 'squash')
    expect(messageTarget(rows, 1)).toEqual({ head: 0, count: 2 })
    expect(messageTarget(rows, 2)).toBeNull()
    expect(messageTarget(setAction(fromPlan(plan()), 1, 'fixup'), 0)).toBeNull()
  })

  it('replaces message exec lines with a readable comment', () => {
    expect(displayTodo(`pick x\nexec git cat-file blob ${MESSAGE_PLACEHOLDER} | git commit\n`, zhT)).toBe('pick x\n# 写回上面这组的提交信息\n')
  })
})

describe('presetIndex', () => {
  it('selects the preset commit (the squash target for a squash), else the first row', () => {
    const rows = fromPlan(plan())
    expect(presetIndex(rows, undefined)).toBe(0)
    expect(presetIndex(rows, { kind: 'reword', sha: sha('c') })).toBe(2)
    expect(presetIndex(rows, { kind: 'squash', shas: [sha('c'), sha('b')] })).toBe(1)
    expect(presetIndex(rows, { kind: 'drop', sha: sha('z') })).toBe(0)
  })
})

describe('afterInteractiveRebase', () => {
  it('opens the conflict list on a conflict stop, otherwise closes; always refreshes', () => {
    for (const [stop, opened, closed] of [['conflict', 1, 0], ['edit', 0, 1], ['exec-failed', 0, 1], [undefined, 0, 1]] as const) {
      const deps = { openConflicts: vi.fn(), close: vi.fn(), refresh: vi.fn() }
      afterInteractiveRebase(stop === undefined ? {} : { stop }, deps)
      expect([deps.openConflicts.mock.calls.length, deps.close.mock.calls.length, deps.refresh.mock.calls.length], String(stop)).toEqual([opened, closed, 1])
    }
  })
})
