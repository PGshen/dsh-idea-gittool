// @vitest-environment happy-dom
// B4d T3: the「未找到 git」/「版本过低」empty state (design §7.2): install link, detect again, set a path.
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitMissingView } from '../../src/client/git-missing.tsx'
import type { GitMissingViewProps } from '../../src/client/git-missing.tsx'
import { byRole, click, render, visibleText } from './dom.tsx'
import type { Rendered } from './dom.tsx'
import { withLocale } from './i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

function show(overrides: Partial<GitMissingViewProps> = {}): GitMissingViewProps {
  const props: GitMissingViewProps = {
    missing: { kind: 'not-found' },
    gitPath: null,
    busy: false,
    error: null,
    onRedetect: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  }
  view = render(withLocale(<GitMissingView {...props} />) as React.ReactElement)
  return props
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('GitMissingView', () => {
  it('says git was not found, links the install guide and detects again', () => {
    const props = show()
    const text = visibleText(view!.container)
    expect(text).toContain('未找到 git 命令')
    expect(byRole(view!.container, 'link', '如何安装 Git').getAttribute('href')).toBe('https://git-scm.com/downloads')

    click(byRole(view!.container, 'button', '重新检测'))

    expect(props.onRedetect).toHaveBeenCalledOnce()
  })

  it('opens a path field and applies the typed path', () => {
    const props = show()
    click(byRole(view!.container, 'button', '设置 git 路径…'))
    const input = byRole(view!.container, 'textbox', 'git 可执行文件路径') as HTMLInputElement
    expect(document.activeElement).toBe(input)

    type(input, '/opt/git/bin/git')
    click(byRole(view!.container, 'button', '应用'))

    expect(props.onApply).toHaveBeenCalledWith('/opt/git/bin/git')
  })

  it('shows the stored path and the last error as an alert', () => {
    show({ gitPath: '/usr/bin/git', error: '该路径不存在。' })
    expect((byRole(view!.container, 'textbox', 'git 可执行文件路径') as HTMLInputElement).value).toBe('/usr/bin/git')
    expect(visibleText(byRole(view!.container, 'alert'))).toBe('该路径不存在。')
  })

  it('names the current and minimum version when git is too old', () => {
    show({ missing: { kind: 'unsupported', current: '2.20.1', minimum: '2.25.0' } })
    const text = visibleText(view!.container)
    expect(text).toContain('Git 版本过低')
    expect(text).toContain('2.20.1')
    expect(text).toContain('2.25.0')
  })

  it('hides the path entry in a read-only session but keeps the install guide and re-detect (t2 T5)', () => {
    const props = show({ readOnly: true, gitPath: '/usr/bin/git' })
    const text = visibleText(view!.container)

    expect(view!.container.querySelector('input')).toBeNull()
    expect(text).not.toContain('设置 git 路径…')
    expect(text).toContain('只读会话不能修改 git 路径；请在可写会话中设置')
    expect(byRole(view!.container, 'link', '如何安装 Git')).toBeTruthy()
    click(byRole(view!.container, 'button', '重新检测'))
    expect(props.onRedetect).toHaveBeenCalledOnce()
  })

  it('disables the buttons while detecting', () => {
    show({ busy: true })
    expect(byRole(view!.container, 'button', '重新检测').hasAttribute('disabled')).toBe(true)
  })
})
