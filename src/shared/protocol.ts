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
  // A2 写端点与推送预览（写端点名避开读端点 `commit`）。
  'commitFiles',
  'amendMessage',
  'rollback',
  'addToVcs',
  'pushPreview',
  'push',
  'pullForPush',
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
  // A2 写操作
  'git/auth-required',
  'git/rejected',
  'git/hook-failed',
  'git/conflict',
  'git/locked',
  'git/index-not-clean',
  'git/operation-in-progress',
  /** 勾选的路径在提交前已被改动/删除（status 快照过期），刷新后重试。 */
  'git/paths-changed',
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

/** 进行中的仓库操作；bisect 于 A1 追加（设计 §7.3）。 */
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null

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
  /** 贮藏条数（`refs/stash` reflog 长度；A1 追加）。读取失败时省略。 */
  stashCount?: number
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
/** 只读原因的稳定代码（A2 追加）：客户端按它取本地化文案，`reason` 只作兜底。 */
export type WritePolicyReasonCode =
  | 'policy-unavailable'
  | 'session-not-live'
  | 'resolve-failed'
  | 'read-only-mode'
  | 'repo-outside-workspace'
  | 'sandbox-unavailable'
  | 'confine-failed'
  | 'partial-enforcement'
  | 'not-a-repository'

export interface WritePolicyValue {
  mode: 'read-write' | 'read-only'
  reason?: string
  reasonCode?: WritePolicyReasonCode
  workspaceRoot?: string
}

/** 仓库版本号：Host 每次感知变化时单调递增，客户端用它丢弃过期响应（调研 §9）。 */
export interface BootstrapValue {
  sessionId: string
  repoRoot: string | null
  status: StatusValue | null
  // A1 起日志页自己分页拉取（`log` 端点）；bootstrap 每 3s 轮询，不再附带日志首页（评审 I5）。
  writePolicy: WritePolicyValue
  version: number
  /** Host 侧 git 版本号（如 `2.50.1`），进程内只探测一次；探测失败时省略（A1 追加）。 */
  gitVersion?: string
  /** 该仓库正在执行或排队的写操作数；>0 时客户端显示「等待当前操作完成」（A2 追加）。 */
  pendingWrites?: number
}

// ---------------------------------------------------------------------------
// A1 只读视图（日志/详情/diff/分支/控制台）
// ---------------------------------------------------------------------------

/** 单文件 diff 的字节/行上限（设计 §16.8：单文件 ≤256KiB、单响应 ≤4MiB）。 */
export const DIFF_FILE_MAX_BYTES = 256 * 1024
export const DIFF_FILE_MAX_LINES = 5000
export const DIFF_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

/** 控制台环形缓冲条数与单条输出上限（设计 §12：最多 200 条）。 */
export const CONSOLE_BUFFER_SIZE = 200
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
  /** 执行目录；`console` 端点据此只返回当前会话仓库的记录（评审 I5）。 */
  cwd?: string
  /** 相同命令（同目录、成功、输出一致）连续重复的次数；轮询类读命令折叠成一条。 */
  repeat?: number
}

export interface ConsoleValue {
  records: ConsoleRecord[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// A2 写操作（提交、Amend、回滚、加入 VCS、推送、推送被拒后拉取）
// ---------------------------------------------------------------------------

/** 写端点超时（设计 §16.4）：本地写 60s，网络 180s；读命令仍是 8s。 */
export const GIT_WRITE_TIMEOUT_MS = 60_000
export const GIT_NETWORK_TIMEOUT_MS = 180_000

/** 单次写请求的路径数与提交信息上限；超出返回 `git/invalid-payload`。 */
export const WRITE_PATHS_MAX = 2000
export const COMMIT_MESSAGE_MAX_BYTES = 64 * 1024

/** 推送预览最多列出的待推送提交数。 */
export const PUSH_PREVIEW_COMMIT_LIMIT = 100

/** 写请求共有字段：`requestId` 由客户端生成，Host 用它对重复提交去重。 */
export interface WriteRequest extends RpcRequest {
  requestId: string
}

/** 只提交勾选的文件（`commit --only`），不改动其余暂存内容。 */
export interface CommitFilesRequest extends WriteRequest {
  /** repo 相对 POSIX 路径；未跟踪路径由 Host 先 `add -N`。 */
  paths: string[]
  message: string
  amend?: boolean
}

/** 无勾选的 Amend：只改 HEAD 的提交信息。 */
export interface AmendMessageRequest extends WriteRequest {
  message: string
}

export interface CommitResultValue {
  sha: string
  shortSha: string
  version?: number
}

/** 回滚（设计 §8.2.5）：已跟踪文件丢弃工作区改动；未跟踪文件仅在显式确认时删除。 */
export interface RollbackRequest extends WriteRequest {
  paths: string[]
  deleteUntracked: boolean
}

export interface RollbackValue {
  /** 已丢弃工作区改动的已跟踪路径。 */
  restored: string[]
  /** 已删除的未跟踪路径。 */
  deleted: string[]
  /** 回滚后暂存区仍有改动的路径（暂存内容按设计保留）。 */
  keptStaged: string[]
  /** 因 `deleteUntracked=false` 跳过的未跟踪路径。 */
  skipped: string[]
  version?: number
}

export interface AddToVcsRequest extends WriteRequest {
  paths: string[]
}

export interface AddToVcsValue {
  added: string[]
  version?: number
}

/** Push 页数据（读端点）。 */
export interface PushPreviewValue {
  remotes: string[]
  /** 当前分支；detached 时为 null，客户端必须让用户显式选择远程分支。 */
  branch: string | null
  detached: boolean
  /** 形如 `origin/main`；无 upstream 时为 null。 */
  upstream: string | null
  /** 建议的远程：upstream 的远程，否则唯一远程或 `origin`；没有远程时为 null。 */
  defaultRemote: string | null
  /** 将被推送的提交（最多 {@link PUSH_PREVIEW_COMMIT_LIMIT} 条）。 */
  commits: CommitSummary[]
  truncated: boolean
  version?: number
}

export interface PushRequest extends WriteRequest {
  remote: string
  /** 远程分支名（不含 `refs/heads/`）；本地推送源是 HEAD。 */
  branch: string
  setUpstream?: boolean
  /** 只提供 `--force-with-lease`，永不提供 `--force`。 */
  forceWithLease?: boolean
  tags?: boolean
}

export interface PushValue {
  remote: string
  branch: string
  /** 远程是否有变化（`up to date` 时为 false）。 */
  updated: boolean
  version?: number
}

/** `git/rejected` 的 `details.reason`。 */
export type PushRejectReason =
  | 'non-fast-forward'
  | 'fetch-first'
  | 'stale-lease'
  | 'protected'
  | 'hook-declined'
  | 'other'

/** `git/rejected` 错误的 `details` 形状（Push Rejected 页据此渲染）。 */
export interface PushRejectedDetails {
  reason: PushRejectReason
  remote: string
  branch: string
  /** 远程上本地没有的提交（fetch 后 `HEAD..<remote>/<branch>`，最多 100 条）。 */
  remoteCommits: CommitSummary[]
  /** porcelain 被拒行的原始说明（已脱敏）。 */
  summary: string
}

/** `git/auth-required` 错误的 `details` 形状。 */
export interface AuthRequiredDetails {
  /** 可在终端里执行的等价命令（不含凭据）。 */
  command: string
}

/** Push Rejected 页的拉取方式；完整 Pull/Update Project 在 A3。 */
export type PullForPushMode = 'rebase' | 'merge'

export interface PullForPushRequest extends WriteRequest {
  remote: string
  branch: string
  mode: PullForPushMode
}

export interface PullForPushValue {
  /** 拉取后的 HEAD。 */
  head: string
  version?: number
}
