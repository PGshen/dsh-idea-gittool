// B3b T6: commit-menu forms — tag, fixup/squash into, patch export, patch apply (static rendering + helpers).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ApplyPatchPageView,
  CreateTagSheetView,
  FixupIntoSheetView,
  PatchPageView,
  patchTextProblem,
  tagNameProblem,
} from '../../../src/client/pages/CommitMenuSheets.tsx'
import { withLocale, zhT } from '../i18n-helpers.tsx'

const noop = (): void => {}

describe('CreateTagSheetView', () => {
  it('asks for a name and an optional annotation; submit waits for a valid name', () => {
    const empty = renderToStaticMarkup(withLocale(<CreateTagSheetView t={zhT} shortSha="abc1234" name="" message="" busy={false} error={null} onChange={noop} onSubmit={noop} onCancel={noop} />))
    expect(empty).toContain('新建标签')
    expect(empty).toContain('附注信息（可选）')
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>创建标签/)
    const bad = renderToStaticMarkup(withLocale(<CreateTagSheetView t={zhT} shortSha="abc1234" name="-x" message="" busy={false} error={null} onChange={noop} onSubmit={noop} onCancel={noop} />))
    expect(bad).toContain('标签名不能以「-」开头或包含空白')
  })

  it('checks names before git does', () => {
    expect(tagNameProblem('  ')?.key).toBe('tag.invalid.empty')
    expect(tagNameProblem('v 1')?.key).toBe('tag.invalid.format')
    expect(tagNameProblem('release/1.0')).toBeNull()
  })
})

describe('FixupIntoSheetView', () => {
  it('lists the checked files; squash adds a message box', () => {
    const fixup = renderToStaticMarkup(withLocale(<FixupIntoSheetView t={zhT} mode="fixup" shortSha="abc1234" subject="feat: x" paths={['a.ts', 'b.ts']} message="" busy={false} error={null} onMessage={noop} onSubmit={noop} onCancel={noop} />))
    expect(fixup).toContain('将带入提交页已勾选的 2 个文件')
    expect(fixup).toContain('a.ts')
    expect(fixup).not.toContain('附加到提交信息的说明')
    const squash = renderToStaticMarkup(withLocale(<FixupIntoSheetView t={zhT} mode="squash" shortSha="abc1234" subject="feat: x" paths={['a.ts']} message="" busy={false} error={null} onMessage={noop} onSubmit={noop} onCancel={noop} />))
    expect(squash).toContain('附加到提交信息的说明')
  })
})

describe('PatchPageView', () => {
  it('previews the patch with download and copy', () => {
    const html = renderToStaticMarkup(withLocale(<PatchPageView t={zhT} count={2} value={{ patch: 'From abc\nSubject: [PATCH] x\n', fileName: '2-commits.patch' }} error={null} onBack={noop} onRetry={noop} onDownload={noop} onCopy={noop} />))
    expect(html).toContain('创建补丁（2 个提交）')
    expect(html).toContain('2-commits.patch')
    expect(html).toContain('Subject: [PATCH] x')
    expect(html).toContain('下载 .patch')
    const loading = renderToStaticMarkup(withLocale(<PatchPageView t={zhT} count={1} value={null} error={null} onBack={noop} onRetry={noop} onDownload={noop} onCopy={noop} />))
    expect(loading).toContain('正在生成补丁')
  })
})

describe('ApplyPatchPageView', () => {
  const view = (patch: string, extra: Partial<Parameters<typeof ApplyPatchPageView>[0]> = {}) => renderToStaticMarkup(withLocale(
    <ApplyPatchPageView t={zhT} patch={patch} preview={null} busy={false} error={null} done={null} onPatch={noop} onFile={noop} onPreview={noop} onApply={noop} onBack={noop} {...extra} />,
  ))

  it('needs text before previewing, and a preview before applying', () => {
    expect(view('')).toMatch(/<button[^>]*disabled=""[^>]*>预览/)
    expect(view('diff --git a/x b/x')).toMatch(/<button[^>]*disabled=""[^>]*>应用/)
    const previewed = view('From 1', { preview: { format: 'mbox', files: ['a.ts'], applied: false, commits: 2 } })
    expect(previewed).toContain('邮件格式补丁：2 个提交，改动 1 个文件')
    expect(previewed).not.toMatch(/<button[^>]*disabled=""[^>]*>应用/)
    expect(view('x', { done: { format: 'diff', files: ['a', 'b'], applied: true } })).toContain('已应用到暂存区（2 个文件）')
  })

  it('refuses empty and oversized text', () => {
    expect(patchTextProblem(' ')?.key).toBe('applyPatch.empty')
    expect(patchTextProblem('x'.repeat(8 * 1024 * 1024 + 1))?.key).toBe('applyPatch.tooLarge')
    expect(patchTextProblem('diff')).toBeNull()
  })
})
