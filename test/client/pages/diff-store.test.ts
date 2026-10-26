/**
 * Diff store：文件切换/关闭时中止在途 RPC、丢弃迟到响应，并给出「在终端查看」命令。
 * 传输状态机与纯格式化函数都做单测；组件渲染见 diff.test.tsx。
 */
import { describe, expect, it } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import { render } from '../../../src/client/localized-text.ts'
import type { CommitFileEntry, DiffFileValue, DiffRequest, RpcResult } from '../../../src/shared/protocol.ts'
import {
  createDiffStore,
  createDiffViewerController,
  fileIndexOf,
  formatBytes,
  hasNoTextChange,
  requestForFile,
  shellQuote,
  terminalCommandFor,
  truncationNotice,
} from '../../../src/client/store/diff-store.ts'
import type { DiffState } from '../../../src/client/store/diff-store.ts'

function diffOf(overrides: Partial<DiffFileValue> = {}): DiffFileValue {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    status: 'M',
    binary: false,
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { type: 'context', oldLine: 1, newLine: 1, text: 'export const a = 1' },
          { type: 'del', oldLine: 2, text: 'const b = 1' },
          { type: 'add', newLine: 2, text: 'const b = 2' },
        ],
      },
    ],
    truncated: false,
    ...overrides,
  }
}

function request(path = 'src/a.ts', scope: DiffRequest['scope'] = 'worktree'): DiffRequest {
  return { sessionId: 's1', path, scope }
}

function controlledLoader(): {
  load: (value: DiffRequest, signal: AbortSignal) => Promise<RpcResult<DiffFileValue>>
  calls: { request: DiffRequest; signal: AbortSignal }[]
  resolveAt: (index: number, value: DiffFileValue) => void
  rejectAt: (index: number, error: { code: 'git/exec-failed'; message: string }) => void
} {
  const calls: { request: DiffRequest; signal: AbortSignal }[] = []
  const pending: ((result: RpcResult<DiffFileValue>) => void)[] = []
  return {
    calls,
    load: (value, signal) => {
      calls.push({ request: value, signal })
      return new Promise<RpcResult<DiffFileValue>>((resolve) => { pending.push(resolve) })
    },
    resolveAt: (index, value) => { pending[index]?.({ ok: true, value }) },
    rejectAt: (index, error) => { pending[index]?.({ ok: false, error }) },
  }
}

describe('createDiffStore', () => {
  it('打开文件后进入 loading，成功后拿到结构化 diff', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    expect(store.getState().status).toBe('idle')

    const done = store.open(request())
    expect(store.getState()).toMatchObject({ status: 'loading', request: request() })
    loader.resolveAt(0, diffOf())
    await done
    expect(store.getState().status).toBe('ready')
    expect(store.getState().value?.hunks[0]?.lines).toHaveLength(3)
  })

  it('切换文件时中止上一个请求，并丢弃它的迟到响应', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const first = store.open(request('src/a.ts'))
    const second = store.open(request('src/b.ts'))
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(loader.calls[1]?.signal.aborted).toBe(false)

    loader.resolveAt(0, diffOf({ newPath: 'src/a.ts' }))
    await first
    expect(store.getState().request?.path).toBe('src/b.ts')
    expect(store.getState().status).toBe('loading')
    expect(store.getState().value).toBeNull()

    loader.resolveAt(1, diffOf({ newPath: 'src/b.ts' }))
    await second
    expect(store.getState().value?.newPath).toBe('src/b.ts')
  })

  it('close 中止在途请求并回到 idle', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const pending = store.open(request())
    store.close()
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(store.getState()).toEqual({ request: null, status: 'idle', value: null, error: null })
    loader.resolveAt(0, diffOf())
    await pending
    expect(store.getState().status).toBe('idle')
  })

  it('失败进入 error；reload 用同一请求重试并清掉错误', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const failed = store.open(request())
    loader.rejectAt(0, { code: 'git/exec-failed', message: 'git 退出码 128' })
    await failed
    expect(store.getState()).toMatchObject({
      status: 'error',
      error: { code: 'git/exec-failed', message: 'git 退出码 128' },
    })

    const retried = store.reload()
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[1]?.request).toEqual(request())
    loader.resolveAt(1, diffOf())
    await retried
    expect(store.getState()).toMatchObject({ status: 'ready', error: null })
  })

  it('idle 时 reload 不发请求', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    await store.reload()
    expect(loader.calls).toHaveLength(0)
  })

  it('把状态变化广播给订阅者', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const seen: DiffState[] = []
    const unsubscribe = store.subscribe(() => { seen.push(store.getState()) })
    const done = store.open(request())
    loader.resolveAt(0, diffOf())
    await done
    expect(seen.map(state => state.status)).toEqual(['loading', 'ready'])
    unsubscribe()
    store.close()
    expect(seen).toHaveLength(2)
  })

  it('loader 抛异常也归一成结构化错误，而不是让状态卡住', async () => {
    const store = createDiffStore({
      load: () => Promise.reject(new Error('boom')),
    })
    await store.open(request())
    expect(store.getState()).toMatchObject({ status: 'error', error: { code: 'git/exec-failed', message: 'boom' } })
  })
})

describe('hasNoTextChange', () => {
  it('没有 hunk 且不是二进制时视为无文本差异', () => {
    expect(hasNoTextChange(diffOf({ hunks: [] }))).toBe(true)
    expect(hasNoTextChange(diffOf())).toBe(false)
    expect(hasNoTextChange(diffOf({ hunks: [], binary: true }))).toBe(false)
  })
})

describe('shellQuote', () => {
  it('普通路径原样输出，含空格/引号的路径用单引号包起来', () => {
    expect(shellQuote('src/a.ts')).toBe('src/a.ts')
    expect(shellQuote('src/a b.ts')).toBe("'src/a b.ts'")
    expect(shellQuote("src/it's.ts")).toBe("'src/it'\\''s.ts'")
  })
})

describe('terminalCommandFor', () => {
  it('按 scope 生成「在终端查看」命令', () => {
    expect(terminalCommandFor(request('src/a.ts', 'worktree'))).toBe('git diff -- src/a.ts')
    expect(terminalCommandFor(request('src/a.ts', 'staged'))).toBe('git diff --cached -- src/a.ts')
    expect(terminalCommandFor({ sessionId: 's1', path: 'src/a.ts', scope: 'commit', sha: 'c1' }))
      .toBe('git show c1 -- src/a.ts')
    expect(terminalCommandFor({ sessionId: 's1', path: 'src/a.ts', scope: 'commit', sha: 'c1', parent: 'p1' }))
      .toBe('git diff p1 c1 -- src/a.ts')
  })

  it('路径含空格时整体加引号', () => {
    expect(terminalCommandFor(request('src/a b.ts'))).toBe("git diff -- 'src/a b.ts'")
  })
})

describe('truncationNotice', () => {
  it('未截断时没有提示', () => {
    expect(truncationNotice(diffOf())).toBeUndefined()
  })

  it('按行截断与按字节截断都给出「仅显示前 N 行」', () => {
    expect(render(zhT, truncationNotice(diffOf({ truncated: true, truncatedReason: 'lines' }))!))
      .toBe('文件过大，仅显示前 3 行（上限 5000 行）。')
    expect(render(zhT, truncationNotice(diffOf({ truncated: true, truncatedReason: 'bytes' }))!))
      .toBe('文件过大，仅显示前 3 行（上限 256KiB）。')
  })
})

describe('Diff 查看器控制器', () => {
  const base: DiffRequest = { sessionId: 's1', path: 'src/a.ts', scope: 'commit', sha: 'c'.repeat(40) }
  const files: CommitFileEntry[] = [
    { path: 'src/a.ts', status: 'M' },
    { path: 'src/b.ts', status: 'A' },
    { path: 'src/c.ts', status: 'D', parentSha: 'p'.repeat(40) },
  ]

  it('requestForFile 换路径并带上分组的父提交', () => {
    expect(requestForFile(base, { path: 'src/b.ts', status: 'A' })).toEqual({ ...base, path: 'src/b.ts' })
    expect(requestForFile(base, { path: 'src/c.ts', status: 'D', parentSha: 'p'.repeat(40) }).parent).toBe('p'.repeat(40))
  })

  it('fileIndexOf 按路径（与父提交）定位当前文件', () => {
    expect(fileIndexOf(files, base)).toBe(0)
    expect(fileIndexOf(files, { ...base, path: 'src/c.ts', parent: 'p'.repeat(40) })).toBe(2)
    expect(fileIndexOf(files, { ...base, path: 'missing.ts' })).toBe(-1)
  })

  it('start 打开初始请求；next/prev 切换文件并中止上一个请求', async () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const switched: string[] = []
    const controller = createDiffViewerController({
      store,
      files,
      onClose: () => {},
      onSwitchFile: request => switched.push(request.path),
    })
    void controller.start(base)
    expect(loader.calls[0]?.request.path).toBe('src/a.ts')
    void controller.next()
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(loader.calls[1]?.request.path).toBe('src/b.ts')
    void controller.next()
    expect(loader.calls[2]?.request.parent).toBe('p'.repeat(40))
    // 已到最后一个：next 不再发请求
    void controller.next()
    expect(loader.calls).toHaveLength(3)
    void controller.prev()
    expect(loader.calls[3]?.request.path).toBe('src/b.ts')
    expect(switched).toEqual(['src/b.ts', 'src/c.ts', 'src/b.ts'])
  })

  it('switchTo 指定文件；当前位置与可切换状态可查询', () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    const controller = createDiffViewerController({ store, files, onClose: () => {} })
    void controller.start(base)
    expect(controller.position()).toEqual({ index: 0, total: 3, hasPrev: false, hasNext: true })
    void controller.switchTo(files[2] as CommitFileEntry)
    expect(controller.position()).toEqual({ index: 2, total: 3, hasPrev: true, hasNext: false })
  })

  it('close 中止在途请求并回调调用方（由调用方恢复来源选中）', () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    let closedWith: DiffRequest | null | undefined
    const controller = createDiffViewerController({ store, files, onClose: (last) => { closedWith = last } })
    void controller.start(base)
    controller.close()
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(store.getState().status).toBe('idle')
    expect(closedWith?.path).toBe('src/a.ts')
  })

  it('Esc 触发关闭并报告已处理；其他键与已被处理的事件不响应', () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    let closed = 0
    const controller = createDiffViewerController({ store, files, onClose: () => { closed += 1 } })
    void controller.start(base)
    expect(controller.handleKey({ key: 'a', defaultPrevented: false })).toBe(false)
    expect(controller.handleKey({ key: 'Escape', defaultPrevented: true })).toBe(false)
    expect(closed).toBe(0)
    expect(controller.handleKey({ key: 'Escape', defaultPrevented: false })).toBe(true)
    expect(closed).toBe(1)
  })

  it('formatBytes 用 B/KiB/MiB 表示大小', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
  })
})

describe('Diff 查看器控制器：文件列表按需读取', () => {
  it('files 传函数时读取最新列表，不需要重建控制器', () => {
    const loader = controlledLoader()
    const store = createDiffStore({ load: loader.load })
    let files: CommitFileEntry[] = [{ path: 'a.ts', status: 'M' }]
    const controller = createDiffViewerController({ store, files: () => files, onClose: () => {} })
    void controller.start({ sessionId: 's1', path: 'a.ts', scope: 'worktree' })
    expect(controller.position().hasNext).toBe(false)
    files = [...files, { path: 'b.ts', status: 'A' }]
    expect(controller.position()).toEqual({ index: 0, total: 2, hasPrev: false, hasNext: true })
    void controller.next()
    expect(loader.calls[1]?.request.path).toBe('b.ts')
  })
})
