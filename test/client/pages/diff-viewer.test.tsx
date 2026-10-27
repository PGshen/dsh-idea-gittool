/**
 * 统一模式 Diff 查看器（设计 §9.2–9.3）：hunk 渲染与折叠、行号与增删标记、虚拟化、
 * 重命名/二进制/无变化/截断分支、顶部工具栏与文件列表交互、Esc 转发。
 * 无 DOM 测试库：静态渲染断言 + 直接调用无 hook 子组件触发回调。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import type { CommitFileEntry, DiffFileValue, DiffHunk, DiffRequest } from '../../../src/shared/protocol.ts'
import { buildDiffRows, DiffHunks, HunkHeaderRow } from '../../../src/client/pages/DiffHunks.tsx'
import { DiffFileList, DiffFileSelect } from '../../../src/client/pages/DiffFileList.tsx'
import { DiffContent, DiffViewer, DiffViewerHeader, DiffViewerView } from '../../../src/client/pages/DiffViewer.tsx'
import type { DiffViewerViewProps } from '../../../src/client/pages/DiffViewer.tsx'

interface AnyElement { type: unknown; props: Record<string, unknown> & { children?: unknown } }

function isElement(node: unknown): node is AnyElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node
}

/** 深度遍历元素树（不展开函数组件）。 */
function findAll(node: unknown, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate))
  if (!isElement(node)) return []
  const own = predicate(node) ? [node] : []
  return [...own, ...findAll(node.props.children, predicate)]
}

function invoke(element: AnyElement | undefined, name: string, ...args: unknown[]): void {
  const handler = element?.props[name]
  if (typeof handler !== 'function') throw new Error(`element has no ${name}`)
  ;(handler as (...values: unknown[]) => void)(...args)
}

function hunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    header: '@@ -1,3 +1,3 @@ export function main',
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [
      { type: 'context', oldLine: 1, newLine: 1, text: 'export const a = 1' },
      { type: 'del', oldLine: 2, text: 'const b = 1' },
      { type: 'add', newLine: 2, text: 'const b = 2' },
      { type: 'context', oldLine: 3, newLine: 3, text: 'return a' },
    ],
    ...overrides,
  }
}

function diffOf(overrides: Partial<DiffFileValue> = {}): DiffFileValue {
  return {
    oldPath: 'src/log/LogTable.tsx',
    newPath: 'src/log/LogTable.tsx',
    status: 'M',
    binary: false,
    hunks: [hunk()],
    truncated: false,
    ...overrides,
  }
}

const REQUEST: DiffRequest = { sessionId: 's1', path: 'src/log/LogTable.tsx', scope: 'commit', sha: '7f3a2c1d4e5f60718293a4b5c6d7e8f901234567' }

const FILES: CommitFileEntry[] = [
  { path: 'src/log/LogTable.tsx', status: 'M', additions: 1, deletions: 1 },
  { path: 'src/log/FilterBar.tsx', status: 'A', additions: 12, deletions: 0 },
]

describe('buildDiffRows', () => {
  it('每个 hunk 一行头 + 若干代码行；折叠的 hunk 只保留头', () => {
    const hunks = [hunk(), hunk({ header: '@@ -10,2 +10,2 @@' })]
    const rows = buildDiffRows(hunks, new Set())
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({ kind: 'hunk', hunkIndex: 0, collapsed: false, lineCount: 4 })
    expect(rows[1]).toMatchObject({ kind: 'line', hunkIndex: 0, lineIndex: 0 })
    const collapsed = buildDiffRows(hunks, new Set([0]))
    expect(collapsed).toHaveLength(6)
    expect(collapsed[0]).toMatchObject({ kind: 'hunk', collapsed: true })
    expect(collapsed[1]).toMatchObject({ kind: 'hunk', hunkIndex: 1 })
  })
})

describe('DiffHunks', () => {
  it('渲染 hunk 头、行号列、增删标记与行类型', () => {
    const html = renderToStaticMarkup(<DiffHunks hunks={[hunk()]} viewportHeight={600} />)
    expect(html).toContain('@@ -1,3 +1,3 @@ export function main')
    expect(html).toContain('data-hunk-header="0"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-line-type="add"')
    expect(html).toContain('data-line-type="del"')
    expect(html).toContain('data-line-type="context"')
    expect(html.replace(/<[^>]+>/gu, '')).toContain('const b = 2')
    expect(html).toContain('data-old-line="2"')
    expect(html).toContain('data-new-line="2"')
    expect(html).toMatch(/data-marker[^>]*>\+</)
    expect(html).toMatch(/data-marker[^>]*>-</)
  })

  it('初始折叠的 hunk 不渲染代码行', () => {
    const html = renderToStaticMarkup(<DiffHunks hunks={[hunk()]} initialCollapsedHunks={[0]} viewportHeight={600} />)
    expect(html).toContain('aria-expanded="false"')
    expect(html.replace(/<[^>]+>/gu, '')).not.toContain('const b = 2')
    expect(html).toContain('4 行')
  })

  it('大 diff 只渲染可视区附近的行（虚拟化）', () => {
    const lines = Array.from({ length: 3000 }, (_, index) => ({
      type: 'add' as const,
      newLine: index + 1,
      text: `line ${index}`,
    }))
    const html = renderToStaticMarkup(
      <DiffHunks hunks={[hunk({ lines, newLines: 3000, oldLines: 0 })]} viewportHeight={400} />,
    )
    const rendered = html.match(/data-line-type=/g)?.length ?? 0
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
    expect(html).not.toContain('line 2999')
    // 总高度按全部行撑开，滚动条反映真实长度
    expect(html).toContain('height:60020px')
  })

  it('有高亮器时按行渲染 token，未知语言（返回 undefined）退回纯文本', () => {
    const highlighted = renderToStaticMarkup(
      <DiffHunks
        hunks={[hunk()]}
        viewportHeight={600}
        highlighter={code => code.split('\n').map(text => [{ text, style: { color: 'var(--shiki-token-keyword)' } }])}
      />,
    )
    expect(highlighted).toContain('color:var(--shiki-token-keyword)')
    const plain = renderToStaticMarkup(<DiffHunks hunks={[hunk()]} viewportHeight={600} highlighter={() => undefined} />)
    expect(plain).not.toContain('--shiki-token')
    // B3b word marks split the changed line; compare the visible text.
    expect(plain.replace(/<[^>]+>/gu, '')).toContain('const b = 2')
    expect(highlighted).toContain('<mark')
  })

  it('hunk 头点击回调折叠切换', () => {
    const toggled: number[] = []
    const row = HunkHeaderRow({ t: zhT, hunkIndex: 3, header: '@@ -1 +1 @@', collapsed: false, lineCount: 2, onToggle: index => toggled.push(index) })
    if (!isElement(row)) throw new Error('expected element')
    invoke(row, 'onClick')
    expect(toggled).toEqual([3])
  })
})

describe('DiffContent 内容规则', () => {
  it('重命名在顶部显示「旧路径 → 新路径」', () => {
    const html = renderToStaticMarkup(
      <DiffContent request={REQUEST} value={diffOf({ status: 'R', oldPath: 'src/old.ts', newPath: 'src/new.ts' })} viewportHeight={600} />,
    )
    expect(html).toContain('data-rename')
    expect(html).toContain('src/old.ts')
    expect(html).toContain('→')
    expect(html).toContain('src/new.ts')
  })

  it('纯重命名（无 hunk）提示内容没有变化', () => {
    const html = renderToStaticMarkup(
      <DiffContent request={REQUEST} value={diffOf({ status: 'R', oldPath: 'a.ts', newPath: 'b.ts', hunks: [] })} viewportHeight={600} />,
    )
    expect(html).toContain('仅重命名')
  })

  it('二进制文件显示大小与新旧哈希，不渲染 hunk', () => {
    const html = renderToStaticMarkup(
      <DiffContent
        request={REQUEST}
        value={diffOf({
          binary: true,
          hunks: [],
          oldSize: 2048,
          newSize: 4096,
          oldSha: '1111111111aaaaaaaaaa',
          newSha: '2222222222bbbbbbbbbb',
        })}
        viewportHeight={600}
      />,
    )
    expect(html).toContain('二进制文件')
    expect(html).toContain('2.0 KiB')
    expect(html).toContain('4.0 KiB')
    expect(html).toContain('1111111111')
    expect(html).toContain('2222222222')
    expect(html).not.toContain('data-hunk-header')
    expect(html).not.toContain('没有文本差异')
  })

  it('新增的二进制文件只有新大小', () => {
    const html = renderToStaticMarkup(
      <DiffContent request={REQUEST} value={diffOf({ binary: true, hunks: [], status: 'A', oldPath: null, newSize: 10 })} viewportHeight={600} />,
    )
    expect(html).toContain('10 B')
    expect(html).toContain('data-binary')
  })

  it('无文本变化给出提示（可能是权限/换行符）', () => {
    const html = renderToStaticMarkup(<DiffContent request={REQUEST} value={diffOf({ hunks: [] })} viewportHeight={600} />)
    expect(html).toContain('没有文本差异')
    expect(html).toContain('权限')
  })

  it('截断时显示「仅显示前 N 行」与「在终端查看」命令', () => {
    const html = renderToStaticMarkup(
      <DiffContent request={REQUEST} value={diffOf({ truncated: true, truncatedReason: 'lines' })} viewportHeight={600} />,
    )
    expect(html).toContain('data-truncated')
    expect(html).toContain('仅显示前 4 行')
    expect(html).toContain('在终端查看')
    expect(html).toContain('git show 7f3a2c1d4e5f60718293a4b5c6d7e8f901234567 -- src/log/LogTable.tsx')
    // 截断时仍渲染已解析的前缀
    expect(html).toContain('data-hunk-header="0"')
  })
})

describe('DiffViewerView', () => {
  function view(overrides: Partial<DiffViewerViewProps> = {}): DiffViewerViewProps {
    return {
      t: zhT,
      request: REQUEST,
      state: { request: REQUEST, status: 'ready', value: diffOf(), error: null },
      files: FILES,
      position: { index: 0, total: 2, hasPrev: false, hasNext: true },
      source: ['日志', '7f3a2c1d'],
      viewportHeight: 600,
      onClose: () => {},
      onPrev: () => {},
      onNext: () => {},
      onSelectFile: () => {},
      onCopy: () => {},
      onRetry: () => {},
      onKeyDown: () => {},
      ...overrides,
    }
  }

  it('顶部有返回、面包屑、文件切换与复制路径；宽屏左侧文件列表标记当前文件', () => {
    const html = renderToStaticMarkup(<DiffViewerView {...view()} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('← 返回')
    expect(html).toContain('日志')
    expect(html).toContain('7f3a2c1d')
    expect(html).toContain('src/log/LogTable.tsx')
    expect(html).toContain('复制路径')
    expect(html).toContain('data-diff-file-list')
    expect(html).toMatch(/aria-current="true"[^>]*data-path="src\/log\/LogTable.tsx"|data-path="src\/log\/LogTable.tsx"[^>]*aria-current="true"/)
    expect(html).toContain('1 / 2')
  })

  it('加载中、错误态', () => {
    const loading = renderToStaticMarkup(
      <DiffViewerView {...view({ state: { request: REQUEST, status: 'loading', value: null, error: null } })} />,
    )
    expect(loading).toContain('加载 diff')
    const failed = renderToStaticMarkup(
      <DiffViewerView
        {...view({ state: { request: REQUEST, status: 'error', value: null, error: { code: 'git/exec-failed', message: 'bad object' } } })}
      />,
    )
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('bad object')
    expect(failed).toContain('重试')
  })

  it('只有一个文件时不显示文件列表与切换', () => {
    const html = renderToStaticMarkup(
      <DiffViewerView {...view({ files: [], position: { index: -1, total: 0, hasPrev: false, hasNext: false } })} />,
    )
    expect(html).not.toContain('data-diff-file-list')
    expect(html).not.toContain('上一个文件')
  })

  it('根节点把按键交给 onKeyDown（Esc 由控制器处理）', () => {
    const keys: string[] = []
    const tree = DiffViewerView(view({ onKeyDown: event => keys.push(event.key) }))
    const root = findAll(tree, element => element.props.role === 'dialog')[0]
    invoke(root, 'onKeyDown', { key: 'Escape', defaultPrevented: false, preventDefault: () => {} })
    expect(keys).toEqual(['Escape'])
  })
})

describe('DiffViewerHeader 交互', () => {
  it('返回、上一个/下一个、复制路径分别回调', () => {
    const calls: string[] = []
    const tree = DiffViewerHeader({
      t: zhT,
      path: 'src/log/LogTable.tsx',
      status: 'M',
      source: ['日志'],
      files: FILES,
      position: { index: 1, total: 2, hasPrev: true, hasNext: false },
      onClose: () => calls.push('close'),
      onPrev: () => calls.push('prev'),
      onNext: () => calls.push('next'),
      onSelectFile: () => calls.push('select'),
      onCopy: text => calls.push(`copy:${text}`),
    })
    invoke(findAll(tree, element => element.props.title === '返回（Esc）')[0], 'onClick')
    invoke(findAll(tree, element => element.props.title === '上一个文件')[0], 'onClick')
    invoke(findAll(tree, element => element.props.title === '复制文件路径')[0], 'onClick')
    expect(calls).toEqual(['close', 'prev', 'copy:src/log/LogTable.tsx'])
    expect(findAll(tree, element => element.props.title === '下一个文件')[0]?.props.disabled).toBe(true)
  })
})

describe('DiffFileList', () => {
  it('点击文件回调选中；当前文件 aria-current', () => {
    const selected: string[] = []
    const tree = DiffFileList({ t: zhT, files: FILES, currentIndex: 1, onSelect: file => selected.push(file.path) })
    const buttons = findAll(tree, element => element.type === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons[1]?.props['aria-current']).toBe('true')
    invoke(buttons[0], 'onClick')
    expect(selected).toEqual(['src/log/LogTable.tsx'])
  })

  it('窄屏下拉：选择回调对应文件', () => {
    const selected: string[] = []
    const tree = DiffFileSelect({ t: zhT, files: FILES, currentIndex: 0, onSelect: file => selected.push(file.path) })
    const select = findAll(tree, element => element.type === 'select')[0]
    invoke(select, 'onChange', { currentTarget: { value: '1' } })
    expect(selected).toEqual(['src/log/FilterBar.tsx'])
  })
})

describe('DiffViewer 容器', () => {
  it('首帧（挂载前）渲染覆盖层与加载态，hook（高亮/虚拟化/store）可在无 DOM 下运行', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        request={REQUEST}
        files={FILES}
        source={['日志', '7f3a2c1d']}
        load={() => new Promise(() => {})}
        onClose={() => {}}
        useHighlighter={() => () => undefined}
      />,
    )
    expect(html).toContain('data-diff-viewer')
    expect(html).toContain('加载 diff')
    expect(html).toContain('1 / 2')
  })
})
