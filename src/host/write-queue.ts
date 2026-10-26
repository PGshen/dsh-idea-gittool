// 每仓库写队列（设计 §16.4「并发与锁」）：同一仓库的写操作严格串行，不同仓库互不阻塞。
// 客户端为每次提交生成 requestId；同一 requestId 的重复请求（双击、Cmd+Enter 连按、
// 网络重试）复用第一次的结果，绝不执行第二次。

/** Completed request ids remembered per repository, oldest evicted first. */
export const WRITE_QUEUE_REMEMBER_COMPLETED = 64

export interface WriteQueueOptions {
  rememberCompleted?: number | undefined
}

export interface WriteQueue {
  /**
   * Run `task` after every earlier write of `repoRoot` settled. A `requestId` seen
   * before (running or recently completed) returns that first outcome instead.
   */
  run: <T>(repoRoot: string, requestId: string, task: () => Promise<T>) => Promise<T>
  /** Writes of `repoRoot` that are running or waiting. */
  pending: (repoRoot: string) => number
}

interface RepoLane {
  tail: Promise<unknown>
  pending: number
  /** requestId → outcome; Map keeps insertion order for eviction. */
  outcomes: Map<string, Promise<unknown>>
  /** Request ids whose outcome settled; only these may be evicted. */
  settled: Set<string>
}

export function createWriteQueue(options: WriteQueueOptions = {}): WriteQueue {
  const remember = options.rememberCompleted ?? WRITE_QUEUE_REMEMBER_COMPLETED
  const lanes = new Map<string, RepoLane>()

  const laneOf = (repoRoot: string): RepoLane => {
    let lane = lanes.get(repoRoot)
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), pending: 0, outcomes: new Map(), settled: new Set() }
      lanes.set(repoRoot, lane)
    }
    return lane
  }

  const run = <T>(repoRoot: string, requestId: string, task: () => Promise<T>): Promise<T> => {
    const lane = laneOf(repoRoot)
    const known = lane.outcomes.get(requestId)
    if (known !== undefined) return known as Promise<T>

    lane.pending += 1
    const outcome = lane.tail.then(task).finally(() => {
      lane.pending -= 1
      lane.settled.add(requestId)
      evict(lane)
    })
    // The next write waits for this one whatever its outcome.
    lane.tail = outcome.catch(() => undefined)
    lane.outcomes.set(requestId, outcome)
    // A replayed failure is observed by its caller; avoid an unhandled rejection here.
    outcome.catch(() => undefined)
    return outcome
  }

  /** Drop the oldest settled ids beyond the limit; running writes are never forgotten. */
  const evict = (lane: RepoLane): void => {
    for (const id of lane.outcomes.keys()) {
      if (lane.outcomes.size <= remember) return
      if (!lane.settled.has(id)) continue
      lane.outcomes.delete(id)
      lane.settled.delete(id)
    }
  }

  const pending = (repoRoot: string): number => lanes.get(repoRoot)?.pending ?? 0

  return { run, pending }
}
