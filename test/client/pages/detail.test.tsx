/**
 * 提交详情与变更文件树（设计 §8.1.5）：字段、合并分组、复制/父提交入口、
 * 空变更、超长正文折叠、目录分组与扁平模式。用静态渲染断言，不引入 DOM 测试库
 * （A1 约定：renderToStaticMarkup）。
 */
/** 固定时区，保证绝对时间文本在任意机器上一致。 */
process.env.TZ = 'Asia/Shanghai'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { render } from '../../../src/client/localized-text.ts'
import { zhT } from '../i18n-helpers.tsx'
import type { CommitDetailValue, CommitFileEntry } from '../../../src/shared/protocol.ts'
import {
  BODY_COLLAPSE_LINES,
  CommitDetail,
  committerDiffers,
  FilesModeToggle,
  HashRow,
  ParentLinks,
  formatRelativeTime,
  relativeLabel,
  shouldCollapseBody,
  commitTimeLabels,
} from '../../../src/client/pages/CommitDetail.tsx'
import {
  buildChangedTree,
  ChangedFilesTree,
  directoryOf,
  FileRow,
  flattenChangedFiles,
} from '../../../src/client/pages/ChangedFilesTree.tsx'

const AUTHOR_DATE = '2026-10-25T09:30:00+08:00'

function file(path: string, status: CommitFileEntry['status'] = 'M', additions = 2, deletions = 0): CommitFileEntry {
  return { path, status, additions, deletions }
}

function detail(overrides: Partial<CommitDetailValue> = {}): CommitDetailValue {
  return {
    sha: '7f3a2c1d4e5f60718293a4b5c6d7e8f901234567',
    shortSha: '7f3a2c1d',
    parents: [{ sha: 'aaaaaaaabbbbccccddddeeeeffff000011112222', shortSha: 'aaaaaaaab', subject: 'parent one' }],
    author: { name: 'Alice', email: 'alice@example.com', date: AUTHOR_DATE },
    committer: { name: 'Alice', email: 'alice@example.com', date: AUTHOR_DATE },
    subject: 'feat(log): 实现日志首屏',
    body: '第一段说明。\n第二段说明。',
    refs: [{ ref: 'refs/heads/main', name: 'main', kind: 'local', sha: '7f3a2c1d4e5f60718293a4b5c6d7e8f901234567' }],
    files: [file('src/log/LogTable.tsx', 'M', 3, 1), file('src/log/FilterBar.tsx', 'A', 12, 0)],
    truncated: false,
    ...overrides,
  }
}

const NOW = new Date('2026-10-27T09:30:00+08:00').getTime()

describe('CommitDetail 字段', () => {
  it('渲染主题、短哈希、refs、作者邮箱与时间（绝对文本 + 相对 tooltip）', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={detail()} status="ready" error={null} now={NOW} />)
    expect(html).toContain('feat(log): 实现日志首屏')
    expect(html).toContain('7f3a2c1d')
    expect(html).toContain('main')
    expect(html).toContain('alice@example.com')
    expect(html).toContain('2026-10-25 09:30')
    expect(html).toContain('title="2 天前"')
    expect(html).toContain('复制修订号')
  })

  it('作者与提交者一致时不显示提交者行，不一致时显示', () => {
    const same = renderToStaticMarkup(<CommitDetail detail={detail()} status="ready" error={null} now={NOW} />)
    expect(same).not.toContain('提交者')
    const different = renderToStaticMarkup(
      <CommitDetail
        detail={detail({ committer: { name: 'Bob', email: 'bob@example.com', date: AUTHOR_DATE } })}
        status="ready"
        error={null}
        now={NOW}
      />,
    )
    expect(different).toContain('提交者 Bob')
    expect(different).toContain('data-committer')
  })

  it('父提交渲染成可点击按钮；根提交给出提示', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={detail()} status="ready" error={null} now={NOW} />)
    expect(html).toContain('父提交')
    expect(html).toContain('data-parent-sha="aaaaaaaabbbbccccddddeeeeffff000011112222"')
    expect(html).toContain('aaaaaaaab')
    const root = renderToStaticMarkup(
      <CommitDetail detail={detail({ parents: [] })} status="ready" error={null} now={NOW} />,
    )
    expect(root).toContain('没有父提交')
  })

  it('短正文没有折叠按钮，超长正文折叠并提供展开入口', () => {
    const short = renderToStaticMarkup(<CommitDetail detail={detail()} status="ready" error={null} now={NOW} />)
    expect(short).not.toContain('展开全部')
    const longBody = Array.from({ length: BODY_COLLAPSE_LINES + 5 }, (_, index) => `第 ${index} 行`).join('\n')
    const collapsed = renderToStaticMarkup(
      <CommitDetail detail={detail({ body: longBody })} status="ready" error={null} now={NOW} />,
    )
    expect(collapsed).toContain('展开全部')
    expect(collapsed).toContain('data-body-collapsed="true"')
    const expanded = renderToStaticMarkup(
      <CommitDetail detail={detail({ body: longBody })} status="ready" error={null} now={NOW} defaultBodyExpanded />,
    )
    expect(expanded).toContain('收起')
  })

  it('非合并提交的文件区显示根标题与文件数', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={detail()} status="ready" error={null} now={NOW} />)
    expect(html).toContain('data-changed-files')
    expect(html).toContain('data-file-count="2"')
    expect(html).toContain('变更文件')
    expect(html).toContain('src/log/LogTable.tsx')
  })

  it('没有变更文件时给出空态提示', () => {
    const html = renderToStaticMarkup(
      <CommitDetail detail={detail({ files: [] })} status="ready" error={null} now={NOW} />,
    )
    expect(html).toContain('该提交没有文件变更')
  })

  it('详情截断时说明只显示前 N 个文件', () => {
    const html = renderToStaticMarkup(
      <CommitDetail detail={detail({ truncated: true })} status="ready" error={null} now={NOW} />,
    )
    expect(html).toContain('仅显示前 2 个')
  })
})

describe('CommitDetail 合并提交分组', () => {
  const merge = detail({
    parents: [
      { sha: 'aaaaaaaabbbbccccddddeeeeffff000011112222', shortSha: 'aaaaaaaab', subject: 'parent one' },
      { sha: 'bbbbbbbbccccddddeeeeffff0000111122223333', shortSha: 'bbbbbbbbc', subject: 'parent two' },
    ],
    files: [file('src/merged.ts', 'M', 1, 1)],
    parentGroups: [
      {
        parentSha: 'aaaaaaaabbbbccccddddeeeeffff000011112222',
        files: [file('src/from-parent-one.ts', 'A', 5, 0)],
      },
      {
        parentSha: 'bbbbbbbbccccddddeeeeffff0000111122223333',
        files: [file('src/from-parent-two.ts', 'D', 0, 7)],
      },
    ],
  })

  it('按父提交分组并显示「对父提交 … 的变更」', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={merge} status="ready" error={null} now={NOW} />)
    expect(html).toContain('data-parent-group="aaaaaaaabbbbccccddddeeeeffff000011112222"')
    expect(html).toContain('data-parent-group="bbbbbbbbccccddddeeeeffff0000111122223333"')
    expect(html).toContain('对父提交 aaaaaaaab 的变更')
    expect(html).toContain('对父提交 bbbbbbbbc 的变更')
    expect(html).toContain('src/from-parent-one.ts')
    expect(html).toContain('src/from-parent-two.ts')
    // 合并提交不再渲染扁平的「变更文件」根节点
    expect(html).not.toContain('data-root')
  })

  it('分组可折叠：折叠的父提交不渲染文件行', () => {
    const html = renderToStaticMarkup(
      <CommitDetail
        detail={merge}
        status="ready"
        error={null}
        now={NOW}
        defaultCollapsedParents={['aaaaaaaabbbbccccddddeeeeffff000011112222']}
      />,
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('src/from-parent-one.ts')
    expect(html).toContain('src/from-parent-two.ts')
  })
})

describe('CommitDetail 加载/错误/空态', () => {
  it('加载中显示占位文案', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={null} status="loading" error={null} />)
    expect(html).toContain('加载提交详情')
  })

  it('未选中提交时提示选择', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={null} status="idle" error={null} />)
    expect(html).toContain('选择一个提交查看详情')
  })

  it('错误态带 alert 语义、错误信息与重试入口', () => {
    const html = renderToStaticMarkup(
      <CommitDetail
        detail={null}
        status="error"
        error={{ code: 'git/exec-failed', message: 'git 退出码 128' }}
        onRetry={() => {}}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('git 退出码 128')
    expect(html).toContain('重试')
  })
})

describe('变更文件树', () => {
  it('按目录聚合并统计每个目录的文件数，目录排在文件前面', () => {
    const tree = buildChangedTree([
      file('src/log/LogTable.tsx'),
      file('src/log/FilterBar.tsx'),
      file('README.md'),
      file('src/client/index.ts'),
    ])
    expect(tree.map(node => `${node.kind}:${node.name}`)).toEqual(['dir:src', 'file:README.md'])
    const src = tree[0]
    expect(src?.kind).toBe('dir')
    if (src?.kind !== 'dir') throw new Error('expected directory node')
    expect(src.count).toBe(3)
    expect(src.children.map(node => `${node.kind}:${node.name}`)).toEqual([
      'dir:client',
      'dir:log',
    ])
    const log = src.children[1]
    if (log?.kind !== 'dir') throw new Error('expected log directory')
    expect(log.count).toBe(2)
    expect(log.path).toBe('src/log')
    expect(log.children.map(node => (node.kind === 'file' ? node.name : node.name))).toEqual([
      'FilterBar.tsx',
      'LogTable.tsx',
    ])
  })

  it('扁平模式按路径排序，并给出文件所在目录', () => {
    expect(flattenChangedFiles([file('b/x.ts'), file('a/y.ts')]).map(entry => entry.path)).toEqual([
      'a/y.ts',
      'b/x.ts',
    ])
    expect(directoryOf('src/log/LogTable.tsx')).toBe('src/log')
    expect(directoryOf('README.md')).toBe('')
  })

  it('树模式渲染目录行与文件行（状态字母 + 增删行数）', () => {
    const html = renderToStaticMarkup(
      <ChangedFilesTree files={[file('src/log/LogTable.tsx', 'M', 3, 1), file('src/log/FilterBar.tsx', 'A', 12, 0)]} label="变更文件" />,
    )
    expect(html).toContain('data-dir="src"')
    expect(html).toContain('data-dir="src/log"')
    expect(html).toContain('data-path="src/log/LogTable.tsx"')
    expect(html).toContain('data-status="M"')
    expect(html).toContain('data-status="A"')
    expect(html).toContain('+3')
    expect(html).toContain('−1')
    expect(html).toContain('aria-expanded="true"')
  })

  it('initialCollapsedDirs 让对应目录初始折叠，不渲染子行', () => {
    const html = renderToStaticMarkup(
      <ChangedFilesTree files={[file('src/log/LogTable.tsx')]} initialCollapsedDirs={['src']} />,
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-path="src/log/LogTable.tsx"')
  })

  it('扁平模式显示目录列', () => {
    const html = renderToStaticMarkup(
      <ChangedFilesTree files={[file('src/log/LogTable.tsx')]} mode="flat" />,
    )
    expect(html).toContain('src/log')
    expect(html).toContain('LogTable.tsx')
  })
})

describe('详情辅助函数', () => {
  it('shouldCollapseBody 按行数与字符数判断', () => {
    expect(shouldCollapseBody('短正文')).toBe(false)
    expect(shouldCollapseBody(Array.from({ length: BODY_COLLAPSE_LINES }, () => 'x').join('\n'))).toBe(false)
    expect(shouldCollapseBody(Array.from({ length: BODY_COLLAPSE_LINES + 1 }, () => 'x').join('\n'))).toBe(true)
  })

  it('committerDiffers 比较姓名与邮箱', () => {
    expect(committerDiffers(detail())).toBe(false)
    expect(committerDiffers(detail({ committer: { name: 'Bob', email: 'alice@example.com', date: AUTHOR_DATE } }))).toBe(true)
  })

  it('relativeLabel 覆盖全部时间桶', () => {
    expect(render(zhT, relativeLabel({ unit: 'now', n: 0 }))).toBe('刚刚')
    expect(render(zhT, relativeLabel({ unit: 'hours', n: 3 }))).toBe('3 小时前')
    expect(render(zhT, relativeLabel({ unit: 'years', n: 2 }))).toBe('2 年前')
  })

  it('formatRelativeTime 处理非法时间', () => {
    expect(formatRelativeTime('not-a-date', NOW, zhT)).toBe('not-a-date')
    expect(formatRelativeTime(AUTHOR_DATE, NOW, zhT)).toBe('2 天前')
  })
})

// ---------------------------------------------------------------------------
// 交互：无 DOM 环境下，直接调用无 hook 的子组件拿到元素树，再触发 onClick。
// ---------------------------------------------------------------------------

interface AnyElement { type: unknown; props: Record<string, unknown> & { children?: unknown } }

function isElement(node: unknown): node is AnyElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node
}

/** 深度遍历元素树（不展开函数组件），收集满足条件的宿主元素。 */
function findAll(node: unknown, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate))
  if (!isElement(node)) return []
  const own = predicate(node) ? [node] : []
  return [...own, ...findAll(node.props.children, predicate)]
}

function click(element: AnyElement | undefined): void {
  const handler = element?.props.onClick
  if (typeof handler !== 'function') throw new Error('element has no onClick')
  ;(handler as () => void)()
}

describe('CommitDetail 交互', () => {
  it('父提交按钮点击后用完整 sha 回调跳转；没有回调时按钮禁用', () => {
    const navigated: string[] = []
    const parents = detail().parents
    const tree = ParentLinks({ t: zhT, parents, onNavigate: sha => navigated.push(sha) })
    const buttons = findAll(tree, element => element.type === 'button')
    expect(buttons).toHaveLength(1)
    click(buttons[0])
    expect(navigated).toEqual(['aaaaaaaabbbbccccddddeeeeffff000011112222'])
    const disabled = findAll(ParentLinks({ t: zhT, parents }), element => element.type === 'button')
    expect(disabled[0]?.props.disabled).toBe(true)
  })

  it('合并提交的多个父提交都可点击', () => {
    const navigated: string[] = []
    const tree = ParentLinks({
      t: zhT,
      parents: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'one' },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'two' },
      ],
      onNavigate: sha => navigated.push(sha),
    })
    for (const button of findAll(tree, element => element.type === 'button')) click(button)
    expect(navigated).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  })

  it('复制按钮把完整 sha 交给复制回调，复制后文案变为「已复制」', () => {
    const copied: string[] = []
    const value = detail()
    const tree = HashRow({ t: zhT, sha: value.sha, shortSha: value.shortSha, refs: value.refs, copied: false, onCopy: text => copied.push(text) })
    const copyButton = findAll(tree, element => element.props.title === '复制完整修订号')[0]
    click(copyButton)
    expect(copied).toEqual([value.sha])
    const html = renderToStaticMarkup(
      <HashRow t={zhT} sha={value.sha} shortSha={value.shortSha} refs={value.refs} copied onCopy={() => {}} />,
    )
    expect(html).toContain('已复制')
  })

  it('文件行点击把完整条目交给打开 diff 的回调', () => {
    const opened: CommitFileEntry[] = []
    const entry = file('src/log/LogTable.tsx', 'M', 3, 1)
    const row = FileRow({ file: entry, name: 'LogTable.tsx', depth: 1, showDirectory: false, onOpenFile: value => opened.push(value) })
    if (!isElement(row)) throw new Error('expected element')
    click(row)
    expect(opened).toEqual([entry])
  })

  it('B2：文件行右键把条目与指针位置交给文件菜单回调，并声明有菜单', () => {
    const menus: Array<[CommitFileEntry, unknown]> = []
    const entry = file('src/log/LogTable.tsx', 'M', 3, 1)
    const row = FileRow({ file: entry, name: 'LogTable.tsx', depth: 1, showDirectory: false, onFileMenu: (value, anchor) => menus.push([value, anchor]) })
    if (!isElement(row)) throw new Error('expected element')
    const props = row.props as { 'aria-haspopup'?: string; onContextMenu?: (event: { preventDefault(): void; clientX: number; clientY: number }) => void }
    expect(props['aria-haspopup']).toBe('menu')
    props.onContextMenu?.({ preventDefault: () => undefined, clientX: 12, clientY: 34 })
    expect(menus).toEqual([[entry, { kind: 'point', x: 12, y: 34 }]])
  })

  it('文件模式切换按钮在树/扁平之间切换', () => {
    const modes: string[] = []
    const tree = FilesModeToggle({ t: zhT, mode: 'tree', onChange: mode => modes.push(mode) })
    if (!isElement(tree)) throw new Error('expected element')
    click(tree)
    const flat = FilesModeToggle({ t: zhT, mode: 'flat', onChange: mode => modes.push(mode) })
    if (!isElement(flat)) throw new Error('expected element')
    click(flat)
    expect(modes).toEqual(['flat', 'tree'])
  })
})

describe('CommitDetail 选中保持与模式', () => {
  it('selectedFile 对应的文件行带 aria-current（Diff 返回后保留选中）', () => {
    const html = renderToStaticMarkup(
      <CommitDetail detail={detail()} status="ready" error={null} now={NOW} selectedFile={{ path: 'src/log/LogTable.tsx' }} />,
    )
    expect(html).toMatch(/aria-current="true"[^>]*data-path="src\/log\/LogTable.tsx"|data-path="src\/log\/LogTable.tsx"[^>]*aria-current="true"/)
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
  })

  it('合并提交只在对应父提交分组里标记选中', () => {
    const merge = detail({
      parents: [
        { sha: 'p1'.padEnd(40, '0'), shortSha: 'p1000000', subject: 'one' },
        { sha: 'p2'.padEnd(40, '0'), shortSha: 'p2000000', subject: 'two' },
      ],
      parentGroups: [
        { parentSha: 'p1'.padEnd(40, '0'), files: [{ ...file('src/same.ts'), parentSha: 'p1'.padEnd(40, '0') }] },
        { parentSha: 'p2'.padEnd(40, '0'), files: [{ ...file('src/same.ts'), parentSha: 'p2'.padEnd(40, '0') }] },
      ],
    })
    const html = renderToStaticMarkup(
      <CommitDetail
        detail={merge}
        status="ready"
        error={null}
        now={NOW}
        selectedFile={{ path: 'src/same.ts', parentSha: 'p2'.padEnd(40, '0') }}
      />,
    )
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    const p2Group = html.slice(html.indexOf(`data-parent-group="${'p2'.padEnd(40, '0')}"`))
    expect(p2Group).toContain('aria-current="true"')
  })

  it('defaultFilesMode=flat 时文件区以扁平模式渲染并提供切换按钮', () => {
    const html = renderToStaticMarkup(
      <CommitDetail detail={detail()} status="ready" error={null} now={NOW} defaultFilesMode="flat" />,
    )
    expect(html).toContain('data-mode="flat"')
    expect(html).toContain('data-files-mode-toggle')
    expect(html).toContain('按目录')
  })

  it('加载新提交时保留旧内容并标记 loading，避免闪烁', () => {
    const html = renderToStaticMarkup(<CommitDetail detail={detail()} status="loading" error={null} now={NOW} />)
    expect(html).toContain('data-loading="true"')
    expect(html).toContain('feat(log): 实现日志首屏')
  })
})

describe('commitTimeLabels (B4a date format)', () => {
  it('puts the chosen format in the text and the other in the title', () => {
    const now = Date.parse('2026-10-25T12:00:00')
    expect(commitTimeLabels('2026-10-25T09:00:00', now, zhT, 'absolute')).toEqual({ text: '2026-10-25 09:00', title: '3 小时前' })
    expect(commitTimeLabels('2026-10-25T09:00:00', now, zhT, 'relative')).toEqual({ text: '3 小时前', title: '2026-10-25 09:00' })
  })
})
