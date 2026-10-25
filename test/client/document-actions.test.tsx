/**
 * Document-header actions: pure path/status helpers plus a render assertion via
 * react-dom/server (no testing-library in this repository).
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  DocumentActions,
  statusLetterOf,
  toRepoRelativePath,
} from '../../src/client/document-actions.tsx'
import type { DocumentActionsProps } from '../../src/client/document-actions.tsx'

function renderActions(props: Partial<DocumentActionsProps> & { absolutePath: string }): string {
  return renderToStaticMarkup(<DocumentActions {...(props as DocumentActionsProps)} />)
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

  it('marks the not-yet-implemented actions disabled', () => {
    const html = renderActions({ absolutePath: '/repo/src/a.ts', statusFor: () => 'A', openBlame: () => null })
    const history = html.match(/<button[^>]*>历史<\/button>/u)?.[0]
    const diff = html.match(/<button[^>]*>Diff<\/button>/u)?.[0]
    expect(history).toBeDefined()
    expect(diff).toBeDefined()
    expect(history).toContain('disabled')
    expect(diff).toContain('disabled')
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
