// 两端共用的 RPC 协议：常量、信封与数据结构。
// 这里只放纯类型与常量，不放依赖运行环境的行为（ARCHITECTURE.md R3）。

/** 浏览器 ↔ Host 的通用 RPC 通道（详见可行性调研 §6）。 */
export const RPC_CHANNEL = '/dsh-git'

/** v1 端点：bootstrap 聚合首屏，status/log 可单独刷新。 */
export const RPC_ENDPOINTS = ['bootstrap', 'status', 'log'] as const

export type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

/** 结构化错误码：处理器永不 throw，一律用这些码返回（可行性调研 §6.2）。 */
export const GIT_ERROR_CODES = [
  'git/no-session',
  'git/not-a-repository',
  'git/invalid-payload',
  'git/exec-failed',
  'git/timeout',
  'git/output-too-large',
  'git/sandbox-denied',
] as const

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number]

export interface GitError {
  code: GitErrorCode
  message: string
  details?: Record<string, unknown>
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: GitError }

/** isRpcResult 的运行时守卫：客户端不解码 schema，只校验信封形状。 */
export function isRpcResult<T = unknown>(value: unknown): value is RpcResult<T> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (candidate.ok === true) return 'value' in candidate
  if (candidate.ok === false) {
    const error = candidate.error
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as GitError).code === 'string' &&
      typeof (error as GitError).message === 'string'
    )
  }
  return false
}

/** 所有请求 payload 都带 sessionId；cwd 由 Host 解析，客户端不传（调研 §7）。 */
export interface RpcRequest {
  sessionId: string
}

/** log 分页游标（M0 T3 追加）：不透明字符串，形如 `v1:<headSha>:<offset>`。 */
export type LogCursor = string

/**
 * log 分页参数（M0 T3 追加）。
 * 客户端只把上一页的 `next` 原样回传；`headSha` 把翻页序列钉在第一页的提交图上，
 * 避免翻页途中新提交插入导致重复或漏项。游标失效时 Host 返回 `git/invalid-payload`。
 */
export interface LogRequest extends RpcRequest {
  cursor?: LogCursor
  limit?: number
}

/** log 每页条数的缺省值与上限（M0 T3 追加）。 */
export const LOG_PAGE_DEFAULT_LIMIT = 50
export const LOG_PAGE_MAX_LIMIT = 200

/** status 单次返回的最大文件条目数；超出时 `StatusValue.truncated` 为 true（M0 T3 追加）。 */
export const STATUS_ENTRY_LIMIT = 500

export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileEntry {
  /** repo 相对的 POSIX 路径。 */
  path: string
  /** 重命名/复制时的原路径。 */
  origPath?: string
  status: FileStatusCode
  additions?: number
  deletions?: number
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface StatusValue {
  branch: string | null
  detached: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileEntry[]
  unstaged: FileEntry[]
  untracked: FileEntry[]
  conflicts: FileEntry[]
  operation: RepoOperation
  truncated: boolean
}

export interface CommitSummary {
  sha: string
  shortSha: string
  parents: string[]
  author: string
  email: string
  /** ISO 8601 作者时间。 */
  date: string
  subject: string
}

export interface LogValue {
  commits: CommitSummary[]
  /** 下一页游标；没有更多时省略。 */
  next?: string
  truncated: boolean
}

/** 写能力判定结果；read-only 时 UI 顶部横幅并禁用写操作（调研 §8.3）。 */
export interface WritePolicyValue {
  mode: 'read-write' | 'read-only'
  reason?: string
  workspaceRoot?: string
}

/** 仓库版本号：Host 每次感知变化时单调递增，客户端用它丢弃过期响应（调研 §9）。 */
export interface BootstrapValue {
  sessionId: string
  repoRoot: string | null
  status: StatusValue | null
  log: LogValue | null
  writePolicy: WritePolicyValue
  version: number
}
