// T7 分支面板：分组建模、当前分支标记、响应式三档、空态/错误态、右键只读菜单。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { branchActions } from '../../../src/client/pages/branch-actions.ts'
import { BRANCH_PANEL_DEFAULT_WIDTH, BRANCH_PANEL_MAX_WIDTH, BRANCH_PANEL_MIN_WIDTH, BranchContextMenu, BranchPanel, clampBranchPanelWidth, drawerEscapeAction } from '../../../src/client/pages/BranchPanel.tsx'
import type { BranchPanelProps } from '../../../src/client/pages/BranchPanel.tsx'
import { DEFAULT_COLLAPSED_GROUPS } from '../../../src/client/pages/branch-store.ts'
import { withLocale } from '../i18n-helpers.tsx'
import { branchesFixture, detachedBranchesFixture } from './branch-fixtures.ts'

const ALL_EXPANDED = { head: false, local: false, remote: false, tags: false } as const

function render(overrides: Partial<BranchPanelProps> = {}): string {
  const props: BranchPanelProps = {
    value: branchesFixture(),
    mode: 'wide',
    open: true,
    search: '',
    collapsedGroups: ALL_EXPANDED,
    collapsedDirs: {},
    flat: false,
    onNavigate: () => {},
    onFilter: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<BranchPanel {...props} />)
}

describe('BranchPanel 结构', () => {
  it('Wide 档渲染四组、可折叠分组头与 tree 语义', () => {
    const html = render()
    expect(html).toContain('data-mode="wide"')
    expect(html).toContain('role="tree"')
    for (const group of ['head', 'local', 'remote', 'tags']) {
      expect(html).toContain(`data-group="${group}"`)
      expect(html).toContain(`data-group-toggle="${group}"`)
    }
    expect(html).toContain('>HEAD<')
    expect(html).toContain('>Local<')
    expect(html).toContain('>Remote<')
    expect(html).toContain('>Tags<')
  })

  it('当前分支行加粗并带 current/head/upstream/↑↓ 信息', () => {
    const html = render()
    expect(html).toContain('data-branch-name="main"')
    expect(html).toContain('data-current="true"')
    expect(html).toContain('data-head="true"')
    expect(html).toContain('data-upstream="origin/main"')
    expect(html).toContain('data-ahead="1"')
    expect(html).toContain('data-behind="2"')
    expect(html).toContain('↑1 ↓2')
    expect(html).toContain('origin/main')
    expect(html).toContain('data-branch-name="chore"')
  })

  it('分组头与目录带文件夹图标，当前分支用星标，其余分支/标签用各自图标', () => {
    const html = render()
    expect(html).toContain('data-tree-icon="folder-open"')
    expect(html).toContain('data-tree-icon="current"')
    expect(html).toContain('data-tree-icon="branch"')
    expect(html).toContain('data-tree-icon="tag"')
    expect(html).toContain('data-expanded="true"')
  })

  it('目录行带 aria-expanded 与子行缩进', () => {
    const html = render()
    expect(html).toContain('data-kind="directory"')
    expect(html).toContain('data-path="feat"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-branch-name="feat/login"')
    expect(html).toContain('aria-level="3"')
  })

  it('折叠分组默认值来自 store：Remote/Tags 收起时不渲染子行', () => {
    const html = render({ collapsedGroups: DEFAULT_COLLAPSED_GROUPS })
    expect(html).toContain('data-group="remote"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-branch-name="origin/main"')
    expect(html).not.toContain('data-branch-name="v1.0.0"')
    expect(html).toContain('data-branch-name="chore"')
  })

  it('折叠目录隐藏子分支', () => {
    const html = render({ collapsedDirs: { feat: true } })
    expect(html).toContain('data-path="feat"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-branch-name="feat/login"')
  })

  it('detached HEAD 显示 detached 说明', () => {
    const html = render({ value: detachedBranchesFixture() })
    expect(html).toContain('data-detached="true"')
    expect(html).toContain('deadbee')
    expect(html).toContain('分离 HEAD')
  })

  it('搜索框受控且显示当前搜索词', () => {
    const html = render({ search: 'feat' })
    expect(html).toContain('type="search"')
    expect(html).toContain('value="feat"')
    expect(html).toContain('aria-label="搜索分支"')
  })

  it('搜索无结果时给出「没有匹配的分支」', () => {
    const html = render({ search: 'zzz' })
    expect(html).toContain('没有匹配的分支')
    expect(html).not.toContain('data-branch-name="main"')
  })

  it('扁平模式把 aria-pressed 置为 true', () => {
    expect(render({ flat: true })).toContain('aria-pressed="true"')
    expect(render({ flat: false })).toContain('aria-pressed="false"')
  })

  it('加载中与失败态', () => {
    expect(render({ value: null, loading: true })).toContain('读取中')
    const failed = render({ value: null, error: { code: 'git/exec-failed', message: 'for-each-ref 退出码 128' } })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('git/exec-failed')
    expect(failed).toContain('重试')
  })

  it('A1 只读：面板不出现签出/新建/删除分支等写入口', () => {
    const html = render()
    for (const writeAction of ['签出', '新建分支', '删除分支', '合并到当前分支']) {
      expect(html).not.toContain(writeAction)
    }
  })
})

describe('BranchPanel 响应式三档', () => {
  it('Standard 未打开时什么都不渲染', () => {
    expect(render({ mode: 'standard', open: false })).toBe('')
  })

  it('Standard 打开为对话框抽屉，并有关闭按钮', () => {
    const html = render({ mode: 'standard', open: true, onClose: () => {} })
    expect(html).toContain('data-mode="standard"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="关闭分支面板"')
  })

  it('Compact 打开为全高覆盖页', () => {
    const html = render({ mode: 'compact', open: true, onClose: () => {} })
    expect(html).toContain('data-mode="compact"')
    expect(html).toContain('role="dialog"')
  })

  it('Wide 收起时只留展开入口', () => {
    const html = render({ mode: 'wide', collapsed: true, onToggleCollapse: () => {} })
    expect(html).toContain('data-collapsed="true"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="tree"')
  })

  it('Wide 底部有收起入口', () => {
    const html = render({ onToggleCollapse: () => {} })
    expect(html).toContain('收起')
  })

  it('Wide 档按 width 设宽，并在右缘提供可调宽的分隔条', () => {
    const html = render({ width: 320, onWidthChange: () => {} })
    expect(html).toContain('width:320px')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-valuenow="320"')
    expect(html).toContain('aria-label="调整分支面板宽度"')
  })

  it('没有 onWidthChange 时不渲染分隔条；抽屉档也没有', () => {
    expect(render()).not.toContain('role="separator"')
    expect(render({ mode: 'standard', onWidthChange: () => {} })).not.toContain('aria-orientation="vertical"')
  })

  it('上游名带 title，被截断时仍能看到全名', () => {
    expect(render()).toContain('title="origin/main"')
  })
})

describe('clampBranchPanelWidth', () => {
  it('夹在 [MIN, min(MAX, 容器一半)] 内，非法值回默认', () => {
    expect(clampBranchPanelWidth(10)).toBe(BRANCH_PANEL_MIN_WIDTH)
    expect(clampBranchPanelWidth(10_000)).toBe(BRANCH_PANEL_MAX_WIDTH)
    expect(clampBranchPanelWidth(300.6)).toBe(301)
    expect(clampBranchPanelWidth(500, 800)).toBe(400)
    expect(clampBranchPanelWidth(500, 200)).toBe(BRANCH_PANEL_MIN_WIDTH)
    expect(clampBranchPanelWidth(Number.NaN)).toBe(BRANCH_PANEL_DEFAULT_WIDTH)
    expect(clampBranchPanelWidth(300, 0)).toBe(300)
  })
})

describe('BranchContextMenu', () => {
  const entry = branchesFixture().local[1]
  if (entry === undefined) throw new Error('fixture missing feat/login')

  it('菜单项来自 branchActions：写动作可用，复制与跳转仍在', () => {
    const items = branchActions(entry, { writable: true, operation: null, current: 'main', dirty: false })
    const html = renderToStaticMarkup(withLocale(<BranchContextMenu entry={entry} items={items} onSelect={() => {}} />))
    expect(html).toContain('role="menu"')
    for (const label of ['签出', '合并到当前分支', '重命名', '删除', '复制名称', '复制完整引用', '在日志中显示', '按此分支过滤日志']) {
      expect(html).toContain(label)
    }
  })

  it('只读时写动作带原因而不可用', () => {
    const items = branchActions(entry, { writable: false, operation: null, current: 'main', dirty: false })
    const html = renderToStaticMarkup(withLocale(<BranchContextMenu entry={entry} items={items} onSelect={() => {}} />))
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('只读模式，不能修改仓库')
  })
})

describe('BranchPanel 抽屉 Esc', () => {
  it('有搜索词时 Esc 先清空搜索，否则关闭抽屉', () => {
    expect(drawerEscapeAction('main')).toBe('clear-search')
    expect(drawerEscapeAction('  ')).toBe('close')
    expect(drawerEscapeAction('')).toBe('close')
  })

  it('Standard/Compact 打开时搜索框自动获得焦点，Wide 档不抢焦点', () => {
    expect(render({ mode: 'standard', open: true })).toContain('data-autofocus="true"')
    expect(render({ mode: 'compact', open: true })).toContain('data-autofocus="true"')
    expect(render({ mode: 'wide' })).not.toContain('data-autofocus')
  })
})
