// Host 侧刷新：监听 .git 关键文件的变更，250ms 防抖合并后通知调用方刷新。
// 只做「什么时候可能变了」的判定，不知道 RPC 与业务数据（T5b 由 rpc.ts 接线）。
// watch 实现由调用方注入（真实运行用 ctx.fs.watch 适配；测试用假实现）。
import { join } from 'node:path'

/** 一次合并后的变更信号。 */
export interface WatchSignal {
  /** 本次防抖窗口内触发过的 watch 目标（绝对路径，去重并排序）。 */
  targets: string[]
  /** 信号产生时刻（毫秒时间戳，取自注入时钟）。 */
  at: number
}

/** watch 句柄的释放函数；同步或异步均可。 */
export type WatchDispose = () => void | Promise<void>

/** watch 句柄：与 ctx.fs.watch 的返回形状对齐。 */
export interface WatchHandle {
  close: WatchDispose
}

/**
 * 注入的 watch 实现：目标变更时调用 `onEvent`，返回释放句柄。
 * 返回 Promise 表示异步初始化（DSH 的 `ctx.fs.watch` 就是这种形状）；
 * 初始化失败通过 Promise 拒绝或同步抛错表达，watchRepo 会转成降级信号。
 */
export type FsWatch = (
  target: string,
  onEvent: () => void,
) => WatchHandle | WatchDispose | Promise<WatchHandle | WatchDispose>

/** 一个目标没能建立监听的原因。 */
export interface WatchFailure {
  /** 未能监听的目标（没有注入实现时为 `<repoRoot>/.git`）。 */
  target: string
  code: 'watch-unavailable' | 'watch-threw' | 'watch-invalid-result'
  /** 便于日志排查的说明。 */
  reason: string
}

/** watchRepo 的返回值：关闭函数 + 降级信号。 */
export interface RepoWatch {
  /** 关闭所有 watch 并清空未触发的防抖；重复调用安全，不会 reject。 */
  close: () => Promise<void>
  /** 所有异步 watch 初始化 settled 后 resolve（失败也算 settled）。 */
  ready: Promise<void>
  /** 降级信号：至少一个目标没有建立监听，调用方应退回轮询。 */
  readonly degraded: boolean
  /** 已建立（或正在异步初始化）监听的目标。 */
  readonly targets: readonly string[]
  /** 失败目标与原因；异步初始化失败后也会更新。 */
  readonly failures: readonly WatchFailure[]
}

export interface WatchRepoOptions {
  /** 仓库根（不是 .git 目录）。 */
  root: string
  /** 合并后的变更通知；信号到来时才调用，调用方抛错不影响监听。 */
  onChange: (signal: WatchSignal) => void
  /** 不传即视为 watch 不可用，返回 degraded=true 而不抛错。 */
  fsWatch?: FsWatch
  /** 防抖窗口，默认 250ms（可行性调研 §9.3）。 */
  debounceMs?: number
  /** 可注入时钟，默认 Date.now；只用于填充 signal.at。 */
  now?: () => number
  /** 初始化失败或后续降级时回调（异步失败也能通知到）。 */
  onDegraded?: (failures: readonly WatchFailure[]) => void
}

/** 一次 git 操作会连续改多个文件，250ms 能合并成一次刷新（调研 §9.3）。 */
export const DEFAULT_DEBOUNCE_MS = 250

/**
 * 计算需要 watch 的 .git 目标（调研 §9.2）。纯函数，不读文件系统。
 *
 * 目录目标只监听直接子项，所以 `refs`、`refs/heads`、`refs/remotes` 都要显式挂上，
 * 才能覆盖「分支指针更新」与 `git pack-refs` / fetch 写入的 packed-refs。
 */
export function gitWatchTargets(repoRoot: string): string[] {
  const gitDir = join(repoRoot, '.git')
  return [
    join(gitDir, 'HEAD'),
    join(gitDir, 'index'),
    join(gitDir, 'packed-refs'),
    join(gitDir, 'refs'),
    join(gitDir, 'refs', 'heads'),
    join(gitDir, 'refs', 'remotes'),
  ]
}

function isWatchPromise(
  value: WatchHandle | WatchDispose | Promise<WatchHandle | WatchDispose>,
): value is Promise<WatchHandle | WatchDispose> {
  if (typeof value === 'object' && value !== null) {
    return typeof (value as { then?: unknown }).then === 'function'
  }
  return false
}

function normalizeDispose(handle: WatchHandle | WatchDispose): WatchDispose | undefined {
  if (typeof handle === 'function') return handle
  if (typeof handle === 'object' && handle !== null && typeof handle.close === 'function') {
    return handle.close
  }
  return undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 监听一个仓库的 .git 关键文件，250ms 防抖合并后调用 `onChange`。
 *
 * 任何一个目标不可用都只记录到 `failures` 并把 `degraded` 置 true，
 * 绝不 throw；调用方据此退回轮询（调研 §9.3）。
 */
export function watchRepo(options: WatchRepoOptions): RepoWatch {
  const {
    root,
    onChange,
    fsWatch,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    now = Date.now,
    onDegraded,
  } = options
  const windowMs = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : DEFAULT_DEBOUNCE_MS

  const targets = gitWatchTargets(root)
  const failures: WatchFailure[] = []
  const disposers: WatchDispose[] = []
  const watched: string[] = []
  const pendingEvents = new Set<string>()
  const initTasks: Promise<void>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let closing: Promise<void> | undefined

  const reportFailure = (failure: WatchFailure): void => {
    failures.push(failure)
    try {
      onDegraded?.([...failures])
    } catch {
      // 降级回调属于调用方逻辑，不能反过来打断监听。
    }
  }

  const flush = (): void => {
    timer = undefined
    if (closed || pendingEvents.size === 0) return
    const merged = [...pendingEvents].sort()
    pendingEvents.clear()
    try {
      onChange({ targets: merged, at: now() })
    } catch {
      // 刷新逻辑抛错不应让 watch 失效；下一次信号照常通知。
    }
  }

  const schedule = (target: string): void => {
    if (closed) return
    pendingEvents.add(target)
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(flush, windowMs)
  }

  const adopt = (target: string, handle: WatchHandle | WatchDispose): void => {
    const dispose = normalizeDispose(handle)
    if (!dispose) {
      reportFailure({
        target,
        code: 'watch-invalid-result',
        reason: 'watch 实现返回了既不是函数也没有 close() 的句柄',
      })
      return
    }
    disposers.push(dispose)
    watched.push(target)
  }

  const closeLate = (handle: WatchHandle | WatchDispose): void => {
    const dispose = normalizeDispose(handle)
    if (!dispose) return
    try {
      void Promise.resolve(dispose()).catch(() => undefined)
    } catch {
      // close 的失败不影响已关闭的事实。
    }
  }

  if (!fsWatch) {
    reportFailure({
      target: join(root, '.git'),
      code: 'watch-unavailable',
      reason: '没有注入 watch 实现，请降级为可见时轮询',
    })
  } else {
    for (const target of targets) {
      try {
        const result = fsWatch(target, () => schedule(target))
        if (isWatchPromise(result)) {
          initTasks.push(
            Promise.resolve(result).then(
              (handle) => {
                if (closed) {
                  closeLate(handle)
                  return
                }
                adopt(target, handle)
              },
              (error: unknown) => {
                if (closed) return
                reportFailure({ target, code: 'watch-threw', reason: describeError(error) })
              },
            ),
          )
        } else {
          adopt(target, result)
        }
      } catch (error) {
        reportFailure({ target, code: 'watch-threw', reason: describeError(error) })
      }
    }
  }

  const ready = Promise.allSettled(initTasks).then(() => undefined)

  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    pendingEvents.clear()
    closing = (async () => {
      for (const dispose of disposers.splice(0)) {
        try {
          await dispose()
        } catch {
          // 释放失败无法补救，保持 close 永不 reject。
        }
      }
    })()
    return closing
  }

  return {
    close,
    ready,
    get degraded(): boolean {
      return failures.length > 0
    },
    get targets(): readonly string[] {
      return [...watched]
    },
    get failures(): readonly WatchFailure[] {
      return [...failures]
    },
  }
}
