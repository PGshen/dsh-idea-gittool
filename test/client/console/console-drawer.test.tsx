// T8 控制台抽屉：渲染、子命令高亮、退出码标红、展开输出、截断标记、清空/暂停/复制入口、无输入框。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  clampDrawerHeight,
  CONSOLE_DEFAULT_HEIGHT,
  CONSOLE_MIN_HEIGHT,
  ConsoleDrawer,
} from '../../../src/client/console/ConsoleDrawer.tsx'
import type { ConsoleDrawerProps } from '../../../src/client/console/ConsoleDrawer.tsx'
import { createConsoleStore } from '../../../src/client/console/console-store.ts'
import type { ConsoleState } from '../../../src/client/console/console-store.ts'
import type { ConsoleRecord } from '../../../src/shared/protocol.ts'
import { failedRecord, record } from './console-fixtures.ts'

function stateOf(records: ConsoleRecord[], patch: (keys: string[]) => Partial<ConsoleState> = () => ({}), truncated = false): ConsoleState {
  const store = createConsoleStore({ load: async () => ({ ok: true, value: { records: [], truncated: false } }) })
  store.apply({ records, truncated })
  const state = store.getState()
  return { ...state, ...patch(state.entries.map(entry => entry.key)) }
}

function render(state: ConsoleState, overrides: Partial<ConsoleDrawerProps> = {}): string {
  return renderToStaticMarkup(
    <ConsoleDrawer
      state={state}
      onClose={() => {}}
      onClear={() => {}}
      onPausedChange={() => {}}
      onToggleExpanded={() => {}}
      {...overrides}
    />,
  )
}

describe('clampDrawerHeight', () => {
  it('夹在最小值与容器 85% 之间，非法值回到默认', () => {
    expect(clampDrawerHeight(50)).toBe(CONSOLE_MIN_HEIGHT)
    expect(clampDrawerHeight(900, 600)).toBe(510)
    expect(clampDrawerHeight(300, 600)).toBe(300)
    expect(clampDrawerHeight(Number.NaN)).toBe(CONSOLE_DEFAULT_HEIGHT)
  })
})

describe('ConsoleDrawer', () => {
  it('默认 240px，带拖拽分隔条与工具条', () => {
    const html = render(stateOf([record()]))
    expect(html).toContain('height:240px')
    expect(html).toContain('role="separator"')
    expect(html).toContain('Git 控制台')
    expect(html).toContain('清空')
    expect(html).toContain('暂停滚动')
    expect(html).toContain('aria-label="关闭 Git 控制台"')
  })

  it('一行显示时间、argv（子命令高亮）、耗时、退出码与复制', () => {
    const html = render(stateOf([record()]))
    expect(html).toContain('data-subcommand="log"')
    expect(html).toContain('core.quotepath=off')
    expect(html).toContain('42 ms')
    expect(html).toContain('退出码 0')
    expect(html).toContain('aria-label="复制命令"')
    expect(html).toContain('dateTime="2026-10-25T04:03:09.120Z"')
  })

  it('非 0 退出码标红并在工具条统计失败数', () => {
    const html = render(stateOf([record(), failedRecord()]))
    expect(html).toContain('data-failed="true"')
    expect(html).toContain('data-exit-code="128"')
    expect(html).toContain('退出码 128')
    expect(html).toContain('data-failed-count="1"')
    expect(html).toContain('fatal: Needed a single revision')
  })

  it('展开后显示 stdout/stderr 全文', () => {
    const collapsed = render(stateOf([failedRecord()]))
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).not.toContain('data-stream="stderr"')
    const expanded = render(stateOf([failedRecord()], keys => ({ expanded: { [keys[0] ?? '']: true } })))
    expect(expanded).toContain('aria-expanded="true"')
    expect(expanded).toContain('data-stream="stderr"')
  })

  it('截断标记：行内「已截断」与展开后的 64KB 提示', () => {
    const state = stateOf([record({ stdoutTruncated: true })], keys => ({ expanded: { [keys[0] ?? '']: true } }))
    const html = render(state)
    expect(html).toContain('data-truncated="true"')
    expect(html).toContain('已截断')
    expect(html).toContain('64KB')
  })

  it('URL 凭据在渲染前已脱敏', () => {
    const html = render(stateOf([record({ argv: ['fetch', 'https://alice:ghp_secret@github.com/r.git'] })]))
    expect(html).not.toContain('ghp_secret')
    expect(html).toContain('https://***@github.com/r.git')
  })

  it('暂停态按钮 aria-pressed 为 true', () => {
    expect(render(stateOf([record()], () => ({ paused: true })))).toContain('aria-pressed="true"')
    expect(render(stateOf([record()]))).toContain('aria-pressed="false"')
  })

  it('空态区分「还没有记录」与「已清空」，空时清空按钮禁用', () => {
    const empty = render(stateOf([]))
    expect(empty).toContain('还没有命令记录')
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>清空<\/button>/)
    expect(render(stateOf([], () => ({ cleared: true })))).toContain('已清空')
  })

  it('读取失败显示错误与重试', () => {
    const html = render(stateOf([], () => ({ error: { code: 'git/no-session', message: '没有会话' } })), { onRetry: () => {} })
    expect(html).toContain('role="alert"')
    expect(html).toContain('git/no-session')
    expect(html).toContain('重试')
  })

  it('Host 环形缓冲丢弃旧记录时给出提示', () => {
    expect(render(stateOf([record()], () => ({}), true))).toContain('仅保留最近 100 条')
  })

  it('全高模式没有分隔条也不设固定高度', () => {
    const html = render(stateOf([record()]), { fullHeight: true })
    expect(html).toContain('data-full-height="true"')
    expect(html).not.toContain('role="separator"')
    expect(html).not.toContain('height:240px')
  })

  it('不提供任何命令输入', () => {
    const html = render(stateOf([record(), failedRecord()]))
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('contenteditable')
  })
})
