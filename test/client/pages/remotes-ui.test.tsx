// B3d T4/T5: sheets and pages for tags, remote branches, upstream, remotes and worktrees (static rendering).
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WORKTREES_DEFAULT, WORKTREES_STORAGE_KEY, isFeatureEnabled } from '../../../src/client/features.ts'
import { RemoteBranchDeleteSheetView, TagSheetView, UpstreamSheetView, WorktreeAddSheetView, defaultWorktreePath, splitRemote } from '../../../src/client/pages/RemoteSheets.tsx'
import { RemotesPageView, WorktreesPageView } from '../../../src/client/pages/RemotesPages.tsx'
import { withLocale, zhT } from '../i18n-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })
const noop = (): void => {}
const frame = { t: zhT, busy: false, error: null, onCancel: noop }

describe('B3d sheets', () => {
  it('tag delete is local-only unless the remote box is ticked', () => {
    const html = renderToStaticMarkup(withLocale(<TagSheetView {...frame} mode="delete" name="v1" remotes={['origin']} remote="origin" alsoRemote={false} onRemote={noop} onAlsoRemote={noop} onSubmit={noop} />))
    expect(html).toContain('将删除本地标签「v1」')
    expect(html).toContain('同时删除远程上的同名标签')
    expect(html).not.toMatch(/data-tag-also-remote[^>]*checked/)
    const push = renderToStaticMarkup(withLocale(<TagSheetView {...frame} mode="push" name="v1" remotes={[]} remote="" alsoRemote={false} onRemote={noop} onAlsoRemote={noop} onSubmit={noop} />))
    expect(push).toContain('没有配置远程')
    expect(push).toMatch(/<button[^>]*disabled=""[^>]*>推送/)
  })

  it('remote branch delete warns with the ref; upstream lists remote branches; worktree add defaults the path', () => {
    expect(renderToStaticMarkup(withLocale(<RemoteBranchDeleteSheetView {...frame} ref_="origin/topic" onSubmit={noop} />))).toContain('将从远程删除分支 origin/topic')
    const upstream = renderToStaticMarkup(withLocale(<UpstreamSheetView {...frame} branch="feat" options={['origin/feat', 'origin/main']} value="origin/feat" onValue={noop} onSubmit={noop} />))
    expect(upstream).toContain('origin/main')
    const add = renderToStaticMarkup(withLocale(<WorktreeAddSheetView {...frame} branch="feat/x" createBranch={false} path={defaultWorktreePath('feat/x')} lockedBranch onChange={noop} onSubmit={noop} />))
    expect(add).toContain('.worktrees/feat-x')
    expect(add).toContain('.gitignore')
    expect(renderToStaticMarkup(withLocale(<WorktreeAddSheetView {...frame} branch="x" createBranch path="../out" lockedBranch={false} onChange={noop} onSubmit={noop} />))).toMatch(/<button[^>]*disabled=""[^>]*>创建/)
  })

  it('splits remote refs and builds safe default paths', () => {
    expect(splitRemote('origin/feat/x')).toEqual({ remote: 'origin', branch: 'feat/x' })
    expect(splitRemote('origin')).toBeNull()
    expect(defaultWorktreePath('feat/a b')).toBe('.worktrees/feat-a-b')
  })
})

describe('B3d pages', () => {
  it('lists remotes with redacted URLs and the edit forms', () => {
    const html = renderToStaticMarkup(withLocale(<RemotesPageView t={zhT} remotes={[{ name: 'origin', fetchUrl: 'https://***@example.com/r.git', pushUrl: 'https://example.com/push.git' }]} loadError={null} edit={{ kind: 'remove', name: 'origin' }} busy={false} error={null} onEdit={noop} onSubmit={noop} onBack={noop} />))
    expect(html).toContain('https://***@example.com/r.git')
    expect(html).toContain('推送 URL：https://example.com/push.git')
    expect(html).toContain('删除远程「origin」')
  })

  it('lists worktrees, marks the current one and asks before a forced removal', () => {
    const worktrees = [
      { path: '/r', head: 'a'.repeat(40), branch: 'main', current: true, locked: false, prunable: false, bare: false, main: true },
      { path: '/r/.worktrees/x', head: 'b'.repeat(40), branch: null, current: false, locked: false, prunable: true, bare: false, main: false },
    ]
    const html = renderToStaticMarkup(withLocale(<WorktreesPageView t={zhT} worktrees={worktrees} loadError={null} removing={{ path: '/r/.worktrees/x', force: true }} busy={false} error={null} message={null} onAdd={noop} onPrune={noop} onCopy={noop} onAskRemove={noop} onRemove={noop} onBack={noop} />))
    expect(html).toContain('当前')
    expect(html).toContain('detached @ bbbbbbb')
    expect(html).toContain('目录已不存在')
    expect(html).toContain('有未提交的改动，强制删除会丢掉这些改动')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>清理/)
  })
})

describe('worktrees flag', () => {
  it('defaults to on since owner acceptance (2026-10-28), and its own key can turn it off', () => {
    expect(WORKTREES_DEFAULT).toBe(true)
    expect(WORKTREES_STORAGE_KEY).toBe('dsh-git.feature.worktrees')
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(isFeatureEnabled('worktrees')).toBe(true)
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === WORKTREES_STORAGE_KEY ? '0' : null) })
    expect(isFeatureEnabled('worktrees')).toBe(false)
  })
})
