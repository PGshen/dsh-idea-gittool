// @vitest-environment happy-dom
// B4b T2: the repo bar ⋯ menu — Esc closes it and gives focus back to ⋯.
import { afterEach, describe, expect, it } from 'vitest'
import { RepoBar } from '../../../src/client/pages/RepoBar.tsx'
import { byRole, click, press, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

describe('repo bar ⋯ menu (DOM)', () => {
  it('Esc closes the menu and returns focus to ⋯', () => {
    view = render(withLocale(<RepoBar repoRoot="/tmp/repo" onRefresh={() => {}} onOpenConsole={() => {}} />) as React.ReactElement)
    const more = byRole(view.container, 'button', '更多操作')
    click(more)
    const menu = byRole(view.container, 'menu')
    press('Escape', menu.querySelector('[role="menuitem"]'))
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)
  })
})
