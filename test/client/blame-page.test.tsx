/**
 * git.blame body (B2 T5): navigation-parameter narrowing, repo path, notices, reload key.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { withLocale } from './i18n-helpers.tsx'

import {
  BlamePageNotice,
  blameNavigationKey,
  blameRepoPath,
  readBlameTarget,
} from '../../src/client/blame-page.tsx'

describe('readBlameTarget', () => {
  it('reads the absolute path from the open parameters', () => {
    expect(readBlameTarget({ absolutePath: '/repo/src/a.ts' })).toEqual({ absolutePath: '/repo/src/a.ts' })
  })

  it('keeps a non-empty repo-relative path', () => {
    expect(readBlameTarget({ absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' }))
      .toEqual({ absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' })
  })

  it('rejects parameters without a usable absolute path', () => {
    expect(readBlameTarget(undefined)).toBeNull()
    expect(readBlameTarget(null)).toBeNull()
    expect(readBlameTarget('dsh-resource://file/x')).toBeNull()
    expect(readBlameTarget({})).toBeNull()
    expect(readBlameTarget({ absolutePath: '' })).toBeNull()
    expect(readBlameTarget({ absolutePath: 42 })).toBeNull()
  })
})

describe('blameRepoPath', () => {
  it('prefers the opener\'s repo-relative path, else derives it from the repository root', () => {
    expect(blameRepoPath({ absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' }, null)).toBe('src/a.ts')
    expect(blameRepoPath({ absolutePath: '/repo/src/a.ts' }, '/repo')).toBe('src/a.ts')
    expect(blameRepoPath({ absolutePath: '/elsewhere/a.ts' }, '/repo')).toBeNull()
    expect(blameRepoPath({ absolutePath: '/repo/src/a.ts' }, null)).toBeNull()
  })
})

describe('BlamePageNotice', () => {
  it('explains a missing target and a file outside the repository', () => {
    expect(renderToStaticMarkup(withLocale(<BlamePageNotice reason="missing" />))).toContain('未提供文件路径')
    const outside = renderToStaticMarkup(withLocale(<BlamePageNotice reason="outside" absolutePath="/elsewhere/a.ts" />))
    expect(outside).toContain('不在当前会话的 Git 仓库中')
    expect(outside).toContain('/elsewhere/a.ts')
    expect(renderToStaticMarkup(withLocale(<BlamePageNotice reason="loading" />))).toContain('正在读取仓库')
  })
})

describe('blameNavigationKey', () => {
  it('changes with every navigation so reopening the page for another file reloads it', () => {
    expect(blameNavigationKey({ revision: 1, params: { absolutePath: '/r/a' } })).not.toBe(
      blameNavigationKey({ revision: 2, params: { absolutePath: '/r/b' } }),
    )
    expect(blameNavigationKey({ revision: 3, params: { absolutePath: '/r/a' } })).toBe(
      blameNavigationKey({ revision: 3, params: { absolutePath: '/r/a' } }),
    )
  })
})
