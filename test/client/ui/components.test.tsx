import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from '../../../src/client/ui/Button.tsx'
import { Chip } from '../../../src/client/ui/Chip.tsx'
import { EmptyState } from '../../../src/client/ui/EmptyState.tsx'
import { StatusLetter } from '../../../src/client/ui/StatusLetter.tsx'
import buttonCss from '../../../src/client/ui/Button.module.css'

describe('基础 UI 组件', () => {
  it('Button 渲染语气类与禁用态', () => {
    const html = renderToStaticMarkup(<Button tone="primary" disabled>提交</Button>)
    expect(html).toContain(buttonCss.button)
    expect(html).toContain(buttonCss.primary)
    expect(html).toContain('disabled')
    expect(html).toContain('提交')
  })

  it('Chip 按 kind 渲染语义类，带 onClick 时是按钮', () => {
    const span = renderToStaticMarkup(<Chip kind="remote">origin/main</Chip>)
    expect(span).toContain('<span')
    expect(span).toContain('origin/main')
    const button = renderToStaticMarkup(<Chip kind="filter" onClick={() => {}}>分支: main</Chip>)
    expect(button).toContain('<button')
  })

  it('StatusLetter 暴露 data-status', () => {
    const html = renderToStaticMarkup(<StatusLetter status="M" />)
    expect(html).toContain('data-status="M"')
  })

  it('EmptyState 的 error 变体带 alert 语义', () => {
    const html = renderToStaticMarkup(<EmptyState title="读取失败" hint="请重试" error />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('读取失败')
  })
})
