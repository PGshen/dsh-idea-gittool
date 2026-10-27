/**
 * Document-header actions: pure path/status helpers plus a render assertion via
 * react-dom/server (no testing-library in this repository).
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zhT } from './i18n-helpers.tsx'

import {
  DocumentActions,
  DocumentActionsView,
  documentActionStates,
  layoutWidth,
  statusLetterOf,
  toRepoRelativePath,
} from '../../src/client/document-actions.tsx'
import type { DocumentActionsProps } from '../../src/client/document-actions.tsx'

function renderActions(props: Partial<DocumentActionsProps> & { absolutePath: string }): string {
  return renderToStaticMarkup(<DocumentActions {...({ t: zhT, ...props } as DocumentActionsProps)} />)
}

describe('toRepoRelativePath', () => {
  it('strips the repository root and returns a POSIX relative path', () => {
    expect(toRepoRelativePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(toRepoRelativePath('/repo/deep/nested/a.ts', '/repo/')).toBe('deep/nested/a.ts')
    expect(toRepoRelativePath('/repo/src/a b.ts', '/repo')).toBe('src/a b.ts')
  })

  it('returns null when the file is outside the repository', () => {
    expect(toRepoRelativePath('/repo-other/a.ts', '/repo')).toBeNull()
    expect(toRepoRelativePath('/elsewhere/a.ts', '/repo')).toBeNull()
  })

  it('returns null without a usable repository root', () => {
    expect(toRepoRelativePath('/repo/a.ts', null)).toBeNull()
    expect(toRepoRelativePath('/repo/a.ts', undefined)).toBeNull()
    expect(toRepoRelativePath('/repo/a.ts', '')).toBeNull()
    expect(toRepoRelativePath('/repo', '/repo')).toBeNull()
  })

  it('accepts Windows separators on both sides', () => {
    expect(toRepoRelativePath('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
    expect(toRepoRelativePath('C:\\repo\\src\\a.ts', 'C:/repo/')).toBe('src/a.ts')
  })

  it('treats a filesystem root as a valid root', () => {
    expect(toRepoRelativePath('/src/a.ts', '/')).toBe('src/a.ts')
  })
})

describe('statusLetterOf', () => {
  it('maps the porcelain change codes to the single display letter', () => {
    expect(statusLetterOf('M')).toBe('M')
    expect(statusLetterOf(' M')).toBe('M')
    expect(statusLetterOf('A')).toBe('A')
    expect(statusLetterOf('D')).toBe('D')
    expect(statusLetterOf('R')).toBe('M')
    expect(statusLetterOf('C')).toBe('M')
    expect(statusLetterOf('T')).toBe('M')
  })

  it('maps untracked and unmerged states to U', () => {
    expect(statusLetterOf('??')).toBe('U')
    expect(statusLetterOf('UU')).toBe('U')
    expect(statusLetterOf('U')).toBe('U')
  })

  it('returns null for clean or unknown codes', () => {
    expect(statusLetterOf('')).toBeNull()
    expect(statusLetterOf('   ')).toBeNull()
    expect(statusLetterOf('.')).toBeNull()
    expect(statusLetterOf('X')).toBeNull()
    expect(statusLetterOf(null)).toBeNull()
    expect(statusLetterOf(undefined)).toBeNull()
  })
})

describe('DocumentActions', () => {
  it('shows the file status letter and the document actions', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts', statusFor: () => 'M' })
    expect(html).toContain('data-status="M"')
    expect(html).toContain('>M<')
    expect(html).toContain('Blame')
    expect(html).toContain('历史')
    expect(html).toContain('Diff')
  })

  it('keeps the slot visible before a status source is wired', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts' })
    expect(html).toContain('data-status="unknown"')
    expect(html).toContain('Blame')
  })

  it('B2: history and diff go to the Git tab for a file of the repository', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts', statusFor: () => 'M', repoRootFor: () => '/repo', openInGit: () => null, openBlame: () => null })
    const history = html.match(/<button[^>]*>历史<\/button>/u)?.[0]
    const diff = html.match(/<button[^>]*>Diff<\/button>/u)?.[0]
    expect(history).not.toContain('disabled')
    expect(diff).not.toContain('disabled')
    expect(html).toMatch(/<button[^>]*data-status="M"/u)
  })

  it('B2: without a repository path history, diff and the status jump are unavailable, with the reason', () => {
    const html = renderActions({ absolutePath: '/elsewhere/a.ts', statusFor: () => 'M', repoRootFor: () => '/repo', openInGit: () => null })
    expect(html.match(/<button[^>]*>历史<\/button>/u)?.[0]).toContain('disabled')
    expect(html).toContain('文件不在当前会话的 Git 仓库中')
  })
  it('exposes the repo-relative path when a root is supplied', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts', repoRootFor: () => '/repo' })
    expect(html).toContain('data-repo-path="src/a.ts"')
  })

  it('omits the repo-relative path when the root is unknown', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts' })
    expect(html).not.toContain('data-repo-path')
  })
})

describe('documentActionStates (B2)', () => {
  const wired = { openInGit: true, openBlame: true }
  it('enables everything for a modified file of the repository', () => {
    expect(documentActionStates({ repoPath: 'src/a.ts', status: 'M', ...wired })).toEqual({
      blame: null, history: null, diff: null, status: null,
    })
  })

  it('a clean file has no worktree diff and no change to select', () => {
    const states = documentActionStates({ repoPath: 'src/a.ts', status: null, ...wired })
    expect(states.diff?.key).toBe('document.diff.clean')
    expect(states.status?.key).toBe('document.diff.clean')
    expect(states.history).toBeNull()
  })

  it('outside the repository only Blame stays (its page explains), the rest name the reason', () => {
    const states = documentActionStates({ repoPath: null, status: 'M', ...wired })
    expect(states.blame).toBeNull()
    expect([states.history?.key, states.diff?.key, states.status?.key]).toEqual(['document.notInRepo', 'document.notInRepo', 'document.notInRepo'])
  })

  it('U (untracked or conflicted) keeps history available; the history page explains an empty one', () => {
    expect(documentActionStates({ repoPath: 'n.txt', status: 'U', ...wired }).history).toBeNull()
  })

  it('nothing wired: every action is unavailable', () => {
    const states = documentActionStates({ repoPath: 'src/a.ts', status: 'M', openInGit: false, openBlame: false })
    expect(Object.values(states).every(reason => reason !== null)).toBe(true)
  })
})

describe('DocumentActionsView compact (B2)', () => {
  it('keeps status and Blame visible and folds history and diff under ⋯', () => {
    const html = renderToStaticMarkup(
      <DocumentActionsView
        t={zhT}
        status="M"
        repoPath="src/a.ts"
        compact
        failure={null}
        states={{ blame: null, history: null, diff: null, status: null }}
        onBlame={() => undefined}
        onIntent={() => undefined}
      />,
    )
    expect(html).toContain('<details')
    expect(html).toContain('⋯')
    expect(html.indexOf('Blame')).toBeLessThan(html.indexOf('<details'))
    expect(html.indexOf('历史')).toBeGreaterThan(html.indexOf('<details'))
  })
})

describe('layoutWidth (L4)', () => {
  type Fake = { clientWidth: number; display: string; parentElement: Fake | null }
  const chain = (...nodes: Array<[number, string]>): Fake => {
    let parent: Fake | null = null
    for (const [clientWidth, display] of [...nodes].reverse()) parent = { clientWidth, display, parentElement: parent }
    if (parent === null) throw new Error('empty chain')
    return parent
  }
  const displayOf = (node: Fake): string => node.display

  it('skips display: contents wrappers and measures the first laid-out ancestor', () => {
    const row = chain([120, 'inline-flex'], [0, 'contents'], [647, 'flex'])
    expect(layoutWidth(row, displayOf)).toBe(647)
  })

  it('returns null when nothing above has a width', () => {
    expect(layoutWidth(chain([120, 'inline-flex'], [0, 'contents']), displayOf)).toBeNull()
  })
})
