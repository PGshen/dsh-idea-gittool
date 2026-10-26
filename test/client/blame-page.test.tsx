/**
 * git.blame body: navigation-parameter narrowing and the M0 empty state.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zhT } from './i18n-helpers.tsx'

import {
  BlameEmptyState,
  BlamePage,
  readBlameTarget,
} from '../../src/client/blame-page.tsx'
import type { BlamePageProps } from '../../src/client/blame-page.tsx'

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

describe('BlameEmptyState', () => {
  it('says the view arrives in B2 and shows the absolute path', () => {
    const html = renderToStaticMarkup(<BlameEmptyState target={{ absolutePath: '/repo/src/a.ts' }} />)
    expect(html).toContain('B2')
    expect(html).toContain('/repo/src/a.ts')
  })

  it('shows the repo-relative path when available', () => {
    const html = renderToStaticMarkup(
      <BlameEmptyState target={{ absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' }} />,
    )
    expect(html).toContain('src/a.ts')
  })

  it('explains a missing target instead of rendering a blank body', () => {
    const html = renderToStaticMarkup(<BlameEmptyState target={null} />)
    expect(html).toContain('未提供文件路径')
  })
})

describe('BlamePage', () => {
  it('reads the target from the tab navigation and renders the empty state', () => {
    const props = {
      useTabInfo: () => ({ tab: { navigation: { params: { absolutePath: '/repo/src/a.ts' } } } }),
      t: zhT,
    } as unknown as BlamePageProps
    const html = renderToStaticMarkup(BlamePage(props))
    expect(html).toContain('/repo/src/a.ts')
    expect(html).toContain('B2')
  })
})
