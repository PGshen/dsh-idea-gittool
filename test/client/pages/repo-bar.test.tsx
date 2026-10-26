// T7 仓库栏：repoRoot 截断、⋯ 菜单只有刷新/Git 控制台、分支入口按档位出现。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RepoBar, repoName, truncateMiddle } from '../../../src/client/pages/RepoBar.tsx'
import type { RepoBarProps } from '../../../src/client/pages/RepoBar.tsx'

function render(overrides: Partial<RepoBarProps> = {}): string {
  const props: RepoBarProps = {
    repoRoot: '/Users/alice/projects/very/deep/path/dsh-idea-gittool',
    onRefresh: () => {},
    onOpenConsole: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<RepoBar {...props} />)
}

describe('truncateMiddle / repoName', () => {
  it('短路径原样返回，长路径中间省略且保留结尾', () => {
    expect(truncateMiddle('/a/b', 20)).toBe('/a/b')
    const result = truncateMiddle('/Users/alice/projects/very/deep/path/repo', 20)
    expect(result).toHaveLength(20)
    expect(result).toContain('…')
    expect(result.endsWith('path/repo')).toBe(true)
    expect(result.startsWith('/Users')).toBe(true)
  })

  it('repoName 取最后一段，兼容结尾斜杠与 Windows 路径', () => {
    expect(repoName('/a/b/repo')).toBe('repo')
    expect(repoName('/a/b/repo/')).toBe('repo')
    expect(repoName('C:\\work\\repo')).toBe('repo')
    expect(repoName(null)).toBe('')
  })
})

describe('RepoBar', () => {
  it('显示仓库名，完整路径放在 title，截断路径单独展示', () => {
    const html = render()
    expect(html).toContain('dsh-idea-gittool')
    expect(html).toContain('title="/Users/alice/projects/very/deep/path/dsh-idea-gittool"')
    expect(html).toContain('…')
  })

  it('没有仓库时显示占位', () => {
    expect(render({ repoRoot: null })).toContain('未打开仓库')
  })

  it('⋯ 菜单默认收起；展开后只有刷新与 Git 控制台', () => {
    const closed = render()
    expect(closed).toContain('aria-haspopup="menu"')
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).not.toContain('role="menu"')
    const open = render({ defaultMenuOpen: true })
    expect(open).toContain('role="menu"')
    expect(open).toContain('刷新')
    expect(open).toContain('Git 控制台')
    for (const write of ['获取', '拉取', '推送', '提交']) expect(open).not.toContain(write)
  })

  it('刷新中禁用刷新项并标注 aria-busy', () => {
    const html = render({ defaultMenuOpen: true, refreshing: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>刷新中…<\/button>/)
  })

  it('非 Wide 档给出「分支」入口，反映打开状态', () => {
    const html = render({ mode: 'standard', onToggleBranches: () => {}, branchesOpen: true })
    expect(html).toContain('data-branches-toggle=""')
    expect(html).toContain('aria-pressed="true"')
    expect(render({ mode: 'wide', onToggleBranches: () => {} })).not.toContain('data-branches-toggle')
  })

  it('控制台有失败记录时 ⋯ 按钮带提示点', () => {
    expect(render({ consoleHasErrors: true })).toContain('data-console-errors="true"')
    expect(render()).not.toContain('data-console-errors')
  })
})

describe('RepoBar / 推送入口（A2 走查问题 1）', () => {
  it('传了 onPush 时显示推送按钮，有待推送提交时带 ↑n', () => {
    const html = render({ onPush: () => {}, ahead: 2 })
    expect(html).toContain('data-repo-push=""')
    expect(html).toContain('↑2')
  })

  it('没有待推送提交时不显示数字；未传 onPush 时不显示按钮', () => {
    expect(render({ onPush: () => {}, ahead: 0 })).not.toContain('↑')
    expect(render()).not.toContain('data-repo-push')
  })
})

function tagOf(html: string, marker: string): string {
  return html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0] ?? ''
}

describe('RepoBar / 获取与拉取（A3 T8）', () => {
  it('传了回调时显示获取与拉取按钮，顺序在推送之前', () => {
    const html = render({ onFetch: () => {}, onPull: () => {}, onPush: () => {} })
    expect(html).toContain('data-repo-fetch=""')
    expect(html).toContain('data-repo-pull=""')
    expect(html.indexOf('data-repo-fetch')).toBeLessThan(html.indexOf('data-repo-pull'))
    expect(html.indexOf('data-repo-pull')).toBeLessThan(html.indexOf('data-repo-push'))
    expect(render()).not.toContain('data-repo-fetch')
  })

  it('只读或操作进行中时禁用并把原因放进 title', () => {
    const html = render({
      onFetch: () => {},
      onPull: () => {},
      fetchDisabledReason: '只读模式，不能修改仓库',
      pullDisabledReason: '有操作进行中，先继续或中止它',
    })
    const fetchTag = tagOf(html, 'data-repo-fetch')
    expect(fetchTag).toContain('disabled=""')
    expect(fetchTag).toContain('title="只读模式，不能修改仓库"')
    const pullTag = tagOf(html, 'data-repo-pull')
    expect(pullTag).toContain('disabled=""')
    expect(pullTag).toContain('title="有操作进行中，先继续或中止它"')
    const enabled = render({ onFetch: () => {}, onPull: () => {} })
    expect(tagOf(enabled, 'data-repo-fetch')).not.toContain('disabled')
    expect(tagOf(enabled, 'data-repo-pull')).not.toContain('disabled')
  })

  it('获取进行中显示进行中文案并禁用', () => {
    const html = render({ onFetch: () => {}, fetching: true })
    expect(html).toContain('获取中…')
    const tag = tagOf(html, 'data-repo-fetch')
    expect(tag).toContain('aria-busy="true"')
    expect(tag).toContain('disabled=""')
  })
})
