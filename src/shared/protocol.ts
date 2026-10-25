// 两端共用的 RPC 协议：常量、信封与数据结构。
// 这里只放纯类型与常量，不放依赖运行环境的行为（ARCHITECTURE.md R3）。

/** 浏览器 ↔ Host 的通用 RPC 通道（详见可行性调研 §6）。 */
export const RPC_CHANNEL = '/dsh-git'

/** A1 端点：bootstrap 聚合首屏；其余端点各自刷新一个视图。 */
export const RPC_ENDPOINTS = [
  'bootstrap',
  'status',
  'log',
  'branches',
  'refs',
  'commit',
  'diff',
  'console',
] as const

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
  /** 文本/哈希搜索（消息、作者、哈希）；P0 由客户端传，Host 执行（A1 追加）。 */
  query?: string
  /** query 按正则解释（A1 追加）。 */
  regex?: boolean
  /** query 区分大小写（A1 追加）。 */
  caseSensitive?: boolean
  /** 分支过滤（ref 名，可多选；A1 追加）。 */
  branches?: string[]
  /** 作者过滤（作者名/邮箱，可多选；A1 追加）。 */
  authors?: string[]
  /** 提交排序：默认 date（A1 追加）。 */
  order?: 'date' | 'topo'
  /** 只看第一父提交（A1 追加）。 */
  firstParent?: boolean
  /** 隐藏合并提交（A1 追加）。 */
  noMerges?: boolean
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
  /** 读取该值时的仓库 version（M0 T5b 追加）；客户端用它丢弃过期响应。 */
  version?: number
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
  /** 读取该页时的仓库 version（M0 T5b 追加）；客户端用它丢弃过期响应。 */
  version?: number
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

// ---------------------------------------------------------------------------
// A1 只读视图（日志/详情/diff/分支/控制台）
// ---------------------------------------------------------------------------

/** 单文件 diff 的字节/行上限（设计 §16.8：单文件 ≤256KiB、单响应 ≤4MiB）。 */
export const DIFF_FILE_MAX_BYTES = 256 * 1024
export const DIFF_FILE_MAX_LINES = 5000
export const DIFF_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

/** 控制台环形缓冲条数与单条输出上限（设计 §12）。 */
export const CONSOLE_BUFFER_SIZE = 100
export const CONSOLE_OUTPUT_MAX_BYTES = 64 * 1024

export type RefKind = 'local' | 'remote' | 'tag'

export interface RefEntry {
  /** 完整 ref 名，如 `refs/heads/main` / `refs/remotes/origin/main` / `refs/tags/v1`。 */
  ref: string
  /** 展示用的短名（去 refs/heads、refs/tags 前缀；远程保留 origin/main）。 */
  name: string
  kind: RefKind
  sha: string
}

/** branches 端点的条目：ref + 与当前分支的关系（A1）。 */
export interface BranchEntry extends RefEntry {
  /** 该 ref 是否指向 HEAD。 */
  head: boolean
  /** 该 ref 是否是当前分支（HEAD 指向的本地分支）。 */
  current: boolean
  upstream?: string
  ahead: number
  behind: number
}

export interface BranchesValue {
  head: { branch: string | null; detached: boolean; sha: string | null }
  local: BranchEntry[]
  remote: BranchEntry[]
  tags: BranchEntry[]
  truncated: boolean
  version?: number
}

/** refs 端点：sha → 指向它的 refs；客户端据此渲染日志行的 refs 胶囊（A1）。 */
export interface RefsValue {
  bySha: Record<string, RefEntry[]>
  truncated: boolean
  version?: number
}

export interface CommitRequest extends RpcRequest {
  sha: string
}

/** 提交详情里的变更文件；合并提交按父提交分组（A1）。 */
export interface CommitFileEntry extends FileEntry {
  /** 该文件相对某个父提交的状态；普通提交等于 files 的 status。 */
  parentSha?: string
}

export interface CommitParentValue {
  sha: string
  shortSha: string
  subject: string
}

export interface CommitDetailValue {
  sha: string
  shortSha: string
  parents: CommitParentValue[]
  author: { name: string; email: string; date: string }
  committer: { name: string; email: string; date: string }
  subject: string
  /** 提交信息正文（不含主题行） */
  body: string
  refs: RefEntry[]
  files: CommitFileEntry[]
  /** 合并提交按父提交分组；普通提交省略。 */
  parentGroups?: { parentSha: string; files: CommitFileEntry[] }[]
  truncated: boolean
  version?: number
}

export type DiffScope = 'worktree' | 'staged' | 'commit'

export interface DiffRequest extends RpcRequest {
  /** repo 相对 POSIX 路径；Host 侧拒绝绝对路径与 `..`。 */
  path: string
  scope: DiffScope
  /** scope=commit 时必填。 */
  sha?: string
  /** 合并提交按父提交比较时指定；省略表示第一父。 */
  parent?: string
}

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineKind
  oldLine?: number
  newLine?: number
  text: string
}

export interface DiffHunk {
  /** 原始 `@@ -a,b +c,d @@` 头。 */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffFileValue {
  oldPath: string | null
  newPath: string | null
  status: FileStatusCode
  binary: boolean
  /** 二进制文件的大小与哈希（设计 §9.3）。 */
  oldSize?: number
  newSize?: number
  oldSha?: string
  newSha?: string
  hunks: DiffHunk[]
  truncated: boolean
  /** 截断原因：bytes / lines / binary。 */
  truncatedReason?: 'bytes' | 'lines' | 'binary'
  version?: number
}

/** 一次 git 调用的控制台记录（Host 侧埋点，设计 §12）。 */
export interface ConsoleRecord {
  /** ISO 8601。 */
  at: string
  /** 实际 argv（不含可执行文件路径）。 */
  argv: string[]
  durationMs: number
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  cancelled?: boolean
  timedOut?: boolean
}

export interface ConsoleValue {
  records: ConsoleRecord[]
  truncated: boolean
}
