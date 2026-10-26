// 两端共用的 RPC 协议：常量、信封与数据结构。
// 这里只放纯类型与常量，不放依赖运行环境的行为（ARCHITECTURE.md R3）。

/** 浏览器 ↔ Host 的通用 RPC 通道（详见可行性调研 §6）。 */
export const RPC_CHANNEL = '/dsh-git'

/**
 * 全部端点。A1 读端点；A2 写端点与推送预览；A3 端点在 T1 一次登记（契约冻结），
 * 未实现的先返回 `git/exec-failed`（`not implemented`），由 T2–T5 逐个替换。
 * 每个端点的请求/响应类型见文末 {@link RpcEndpointTypes}。
 */
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
  // A3 读端点
  'operationState',
  'conflictCommand',
  'resetPreview',
  'stashList',
  'stashFiles',
  // A3 写端点：操作控制与冲突（T2/T3）
  'operationControl',
  'operationCommit',
  'resolveConflict',
  // A3 写端点：分支（T3）
  'checkout',
  'createBranch',
  'renameBranch',
  'deleteBranch',
  // A3 写端点：集成与网络（T4）
  'merge',
  'rebase',
  'cherryPick',
  'revertCommit',
  'reset',
  'fetch',
  'pull',
  'updateProject',
  'resetToRemote',
  // A3 写端点：贮藏（T5）
  'stashCreate',
  'stashApply',
  'stashDrop',
] as const

export type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

/**
 * 写端点（A2 + A3）：都要求 `requestId`，经每仓库写队列与写门禁执行，只读模式下拒绝。
 * 客户端用 {@link WriteEndpoint} 约束写动作入口（A3 T6 `actions.run`）。
 */
export const WRITE_ENDPOINTS = [
  'commitFiles',
  'amendMessage',
  'rollback',
  'addToVcs',
  'push',
  'pullForPush',
  'operationControl',
  'operationCommit',
  'resolveConflict',
  'checkout',
  'createBranch',
  'renameBranch',
  'deleteBranch',
  'merge',
  'rebase',
  'cherryPick',
  'revertCommit',
  'reset',
  'fetch',
  'pull',
  'updateProject',
  'resetToRemote',
  'stashCreate',
  'stashApply',
  'stashDrop',
] as const satisfies readonly RpcEndpoint[]

export type WriteEndpoint = (typeof WRITE_ENDPOINTS)[number]

/** 运行时判断一个端点是否是写端点。 */
export function isWriteEndpoint(endpoint: string): endpoint is WriteEndpoint {
  return (WRITE_ENDPOINTS as readonly string[]).includes(endpoint)
}

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
  // A3（details 形状见下方 *Details 类型）
  /** 签出会覆盖本地改动：{@link WouldOverwriteDetails}；客户端弹智能签出。 */
  'git/would-overwrite',
  /** `branch -d` 拒绝删除未合并分支：{@link NotMergedDetails}；客户端给「强制删除」确认。 */
  'git/not-merged',
  /** 智能操作遇到未提交的已跟踪改动且请求未带 `stash: true`：{@link DirtyWorktreeDetails}。 */
  'git/dirty-worktree',
  /** 更新项目发现上游被强推（旧 tip 不是新 tip 的祖先）：{@link UpstreamRewrittenDetails}。 */
  'git/upstream-rewritten',
  /** 请求所指的对象（贮藏、冲突文件、HEAD 等）在执行前已变化：{@link StaleTargetDetails}。 */
  'git/stale-target',
  /** 新建/重命名的目标分支已存在：{@link BranchExistsDetails}。 */
  'git/branch-exists',
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

/**
 * 冲突类型（A3）：porcelain v2 `u` 记录的 XY 映射——UU both-modified、AA both-added、
 * DD both-deleted、AU added-by-us、UA added-by-them、DU deleted-by-us、UD deleted-by-them。
 * 「us」是 git 的 ours：合并/拣选/回滚时是当前分支，变基时是目标分支（onto）。
 */
export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them'

export interface FileEntry {
  /** repo 相对的 POSIX 路径。 */
  path: string
  /** 重命名/复制时的原路径。 */
  origPath?: string
  status: FileStatusCode
  additions?: number
  deletions?: number
  /** 只出现在 `conflicts` 里的条目上（A3）。 */
  conflict?: ConflictKind
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
  /** 变基进度（A3 T2，横幅显示 `2/5`）；只在变基进行中且能读到进度时出现。 */
  operationStep?: OperationStep
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
  /** 经 stdin 传给 git 的字节数（A3：pathspec 与提交信息走 stdin）；内容不记录。 */
  stdinBytes?: number
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
  /**
   * 确认框里列出的未跟踪路径（A3 T5，TD-8）：`deleteUntracked` 时只删除
   * 「执行时未跟踪 ∩ confirmedUntracked」，其余进 `skipped`；省略视为空集（不删任何文件）。
   */
  confirmedUntracked?: string[]
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
  /**
   * 用户看过的远程 tip（A3 T4，TD-10，来自 {@link PushRejectedDetails.remoteSha}）。
   * 与 `forceWithLease` 同时给出时用 `--force-with-lease=refs/heads/<branch>:<sha>`。
   */
  expectedRemoteSha?: string
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
  /** fetch 后的远程分支 tip（A3 T4，TD-10）；强推时回传为 `expectedRemoteSha`。取不到时省略。 */
  remoteSha?: string
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

// ---------------------------------------------------------------------------
// A3 分支 / 贮藏 / 冲突（T1 冻结契约；实现分别在 T2–T5）
// 约定：写请求都扩展 WriteRequest（带 requestId）；用户输入的分支名/修订号/远程名
// 由 Host 校验并用 `--end-of-options` / `--` 分隔；sha 一律是完整 40/64 位十六进制。
// ---------------------------------------------------------------------------

/** 会先询问「贮藏并继续 / 取消」的智能操作（贮藏信息 `dsh-git: before <kind>` 与询问文案都用它）。 */
export type SmartOperationKind = 'checkout' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'pull' | 'update'

/** 可能停在冲突、能用智能贮藏的写请求共有字段（T2 `withSmartStash`）。 */
export interface SmartWriteRequest extends WriteRequest {
  /** true：有未提交的已跟踪改动时先贮藏、完成后恢复；省略/false：遇到改动返回 `git/dirty-worktree`。 */
  stash?: boolean
}

/** 智能操作的贮藏结果，并入各写端点的响应。 */
export interface SmartStashOutcome {
  /** 操作前做过贮藏且已成功恢复。 */
  stashRestored?: boolean
  /** 贮藏仍保留（恢复冲突，或操作停在冲突、待操作结束后恢复）。 */
  stashKept?: boolean
  /** T3 修复轮追加：操作期间贮藏已不在列表里（例如被手动删除），无从恢复；不算错误。 */
  stashMissing?: boolean
}

// --- 错误 details 形状 -------------------------------------------------------

/** 智能操作列出的改动路径上限。 */
export const DIRTY_PATHS_LIMIT = 50

/** `git/dirty-worktree`。 */
export interface DirtyWorktreeDetails {
  /** 发起的智能操作；`resetToRemote`（不是智能操作、不提供贮藏）返回该错误时省略。 */
  operation?: SmartOperationKind
  /** 未提交的已跟踪改动（最多 {@link DIRTY_PATHS_LIMIT} 条）。 */
  paths: string[]
  /** 改动总数（可能大于 `paths.length`）。 */
  count: number
}

/** `git/would-overwrite`。 */
export interface WouldOverwriteDetails {
  /** git 报告会被覆盖的已跟踪改动路径（最多 {@link DIRTY_PATHS_LIMIT} 条；只有未跟踪文件挡路时为空数组）。 */
  paths: string[]
  /**
   * T3 修复轮追加：挡路的未跟踪文件/目录（git 会拒绝覆盖或删除它们，最多 {@link DIRTY_PATHS_LIMIT} 条）。
   * 智能贮藏只收已跟踪改动，帮不了它们；强制签出会覆盖它们。没有时省略。
   */
  untracked?: string[]
}

/** `git/not-merged`。 */
export interface NotMergedDetails {
  branch: string
}

/** `git/branch-exists`。 */
export interface BranchExistsDetails {
  branch: string
}

/** `git/upstream-rewritten`。 */
export interface UpstreamRewrittenDetails {
  /** fetch 前的远程跟踪 tip。 */
  oldSha: string
  /** fetch 后的远程跟踪 tip。 */
  newSha: string
  /** 本地分支相对新 tip 独有的提交数（重置到远程会丢掉它们，备份分支保留）。 */
  localAhead: number
}

/** `git/stale-target`：`target` 说明哪类对象已变化。 */
export interface StaleTargetDetails {
  target: 'stash' | 'conflict' | 'head' | 'branch'
  /** 请求里的 sha 或路径。 */
  expected?: string
}

/** A3 中 `git/conflict` 的 details（各字段按场景出现）。 */
export interface ConflictDetails {
  /** 停在冲突的操作。 */
  operation?: RepoOperation
  /** 当前未解决冲突数（continue 被拒或停在下一个冲突时）。 */
  conflicts?: number
  /** 用户的贮藏仍保留（A2 `pull` 的 `autostash` 在 T2 统一改名为此字段）。 */
  stashKept?: boolean
  /** mark-resolved 时文件里仍有 `<<<<<<<` 标记；客户端二次确认后带 `force: true` 重发。 */
  markers?: boolean
}

// --- 操作状态与控制（T2） ------------------------------------------------------

export interface OperationStep {
  /** 当前步（1 起）。 */
  current: number
  total: number
}

/**
 * 冲突一侧的展示信息。合并：ours = 当前分支、theirs = 被合并分支（取自 MERGE_MSG，解析不到用短哈希）；
 * 变基：ours = 目标分支（onto）、theirs = 正在重放的分支；拣选/回滚：ours = 当前分支、theirs = 短哈希。
 */
export interface ConflictSide {
  /** 直接显示在「采用 …」按钮上的名字。 */
  label: string
  /** 完整 ref（如 `refs/heads/main`），有时才给。 */
  ref?: string
  sha?: string
}

/** `operationState`（读，请求只带 sessionId）。 */
export interface OperationStateValue {
  /** 进行中的操作；没有操作时为 null（此时 ours 描述 HEAD，theirs.label 为空串，冲突列表为空）。 */
  operation: RepoOperation
  ours: ConflictSide
  theirs: ConflictSide
  /** 变基进度（`rebase-merge/msgnum`/`end` 或 `rebase-apply/next`/`last`）。 */
  step?: OperationStep
  /** 合并时为 `MERGE_MSG`（去掉 `#` 注释行），供提交页预填。 */
  message?: string
  /** 未解决冲突（带 {@link FileEntry.conflict}）。 */
  conflicts: FileEntry[]
  /** 本次操作中已解决的路径：已无冲突、相对 HEAD 有暂存改动。 */
  resolved: string[]
  /** 有一份待操作结束后恢复的智能贮藏（`<gitDir>/dsh-git/pending-stash.json`）。 */
  pendingStash: boolean
  version?: number
}

export type OperationControlAction = 'continue' | 'skip' | 'abort'

/** `operationControl`：continue / skip（仅变基与拣选）/ abort。 */
export interface OperationControlRequest extends WriteRequest {
  action: OperationControlAction
}

export interface OperationControlValue {
  /** 执行后仍在进行的操作；走完或中止后为 null。 */
  operation: RepoOperation
  head: string
  /** 操作结束后按 sha 恢复了待恢复贮藏。 */
  stashRestored?: boolean
  /** 待恢复贮藏已不在贮藏列表里（例如被用户手动删除）；不算错误。 */
  stashMissing?: boolean
  /**
   * 贮藏保留、没有自动恢复：恢复冲突；或待恢复贮藏不属于刚结束的操作（操作种类或分支对不上，
   * T2 评审 M1，此时 `operationState.pendingStash` 仍为 true，由用户显式恢复）；或恢复时 git 出错。
   */
  stashKept?: boolean
  /** 恢复时遇到冲突以外的 git 错误（T2 评审追加）；贮藏保留。 */
  stashError?: string
  version?: number
}

/** `operationCommit`：合并中提交（信息经 stdin `commit -F -`，不带 pathspec）→ {@link OperationCommitValue}。 */
export interface OperationCommitRequest extends WriteRequest {
  message: string
}

/**
 * `operationCommit` 的结果（T2 追加，{@link CommitResultValue} 的超集）：提交结束了合并，
 * 待恢复贮藏随即按 sha 恢复，字段含义同 {@link OperationControlValue}。
 */
export interface OperationCommitValue extends CommitResultValue {
  stashRestored?: boolean
  stashMissing?: boolean
  stashKept?: boolean
  /** 提交已成功、但恢复贮藏时 git 出错（贮藏保留）。 */
  stashError?: string
}

// --- 冲突（T3） -----------------------------------------------------------------

/** ours/theirs：采用该侧（该侧已删除时等价于删除文件）；delete：删除文件；mark-resolved：按当前内容标记已解决。 */
export type ConflictResolution = 'ours' | 'theirs' | 'delete' | 'mark-resolved'

/** `resolveConflict`：路径必须在执行时的冲突列表里，否则 `git/stale-target`。 */
export interface ResolveConflictRequest extends WriteRequest {
  path: string
  resolution: ConflictResolution
  /** mark-resolved 遇到冲突标记时，用户确认后重发。 */
  force?: boolean
}

export interface ResolveConflictValue {
  path: string
  /** 执行后剩余的未解决冲突数。 */
  remaining: number
  version?: number
}

/** `conflictCommand`（读，请求只带 sessionId）：「在终端解决」的可复制命令，不含凭据。 */
export interface ConflictCommandValue {
  /** 形如 `cd <repo> && git status && git mergetool`。 */
  command: string
}

// --- 分支（T3） -----------------------------------------------------------------

export type CheckoutTargetKind = 'local' | 'remote' | 'tag' | 'revision'

export interface CheckoutTarget {
  kind: CheckoutTargetKind
  /** local：分支名；remote：`origin/x`；tag：标签名；revision：任意可解析为提交的修订号。 */
  name: string
}

/** normal：直接签出（会覆盖改动时 `git/would-overwrite`）；stash：智能签出；force：丢弃会被覆盖的改动。 */
export type CheckoutMode = 'normal' | 'stash' | 'force'

/** `checkout`。 */
export interface CheckoutRequest extends WriteRequest {
  target: CheckoutTarget
  /** 默认 normal。 */
  mode?: CheckoutMode
}

export interface CheckoutValue {
  /** 签出后的当前分支；detached 时为 null。 */
  branch: string | null
  detached: boolean
  head: string
  /** mode=stash 时贮藏已恢复。 */
  stashRestored?: boolean
  /** mode=stash 且恢复冲突时贮藏保留。 */
  stashKept?: boolean
  /** T3 修复轮追加：mode=stash 时贮藏在签出期间消失，无从恢复。 */
  stashMissing?: boolean
  version?: number
}

/** `createBranch`：名称经 `check-ref-format --branch`；已存在 → `git/branch-exists`。 */
export interface CreateBranchRequest extends WriteRequest {
  name: string
  /** 起点修订号（分支名、标签或 sha）。 */
  startPoint: string
  /** 新建后立即签出。 */
  checkout: boolean
}

export interface CreateBranchValue {
  branch: string
  /** 新分支指向的提交。 */
  sha: string
  checkedOut: boolean
  version?: number
}

/** `renameBranch`（仅本地）：目标已存在 → `git/branch-exists`。 */
export interface RenameBranchRequest extends WriteRequest {
  from: string
  to: string
}

export interface RenameBranchValue {
  branch: string
  version?: number
}

/** `deleteBranch`（仅本地）：当前分支 → `git/invalid-payload`；`-d` 未合并 → `git/not-merged`。 */
export interface DeleteBranchRequest extends WriteRequest {
  name: string
  /** true 用 `-D`（客户端在 `git/not-merged` 后二次确认）。 */
  force: boolean
  /**
   * 用户看到的分支 tip（来自 branches 列表）。给出时 Host 在执行时重新读取分支，
   * 不一致 → `git/stale-target`（`target: 'branch'`），不删除意料之外的提交。
   */
  expectedSha?: string
}

export interface DeleteBranchValue {
  branch: string
  /** 被删除分支原来的 tip（便于提示与找回）。 */
  sha: string
  version?: number
}

// --- 集成操作（T4） -------------------------------------------------------------

/** 合并/变基/拣选/回滚/拉取/更新项目的共同结果。 */
export interface IntegrateValue extends SmartStashOutcome {
  head: string
  /** false：改动留在索引未提交（squash / no-commit）。 */
  committed: boolean
  version?: number
}

/** `merge`：`merge --no-edit [--no-ff|--squash|--no-commit] --end-of-options <ref>`。 */
export interface MergeRequest extends SmartWriteRequest {
  ref: string
  noFf?: boolean
  squash?: boolean
  noCommit?: boolean
}

/** `rebase`：当前分支变基到 `onto`。 */
export interface RebaseRequest extends SmartWriteRequest {
  onto: string
}

/** `cherryPick`：合并提交 → `git/invalid-payload`（需要 `-m`，P1）。 */
export interface CherryPickRequest extends SmartWriteRequest {
  sha: string
}

/** `revertCommit`：`revert --no-edit`；合并提交 → `git/invalid-payload`。 */
export interface RevertCommitRequest extends SmartWriteRequest {
  sha: string
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

/** `reset`：hard 必须带 `confirmHard: true`，否则 `git/invalid-payload`。 */
export interface ResetRequest extends WriteRequest {
  sha: string
  mode: ResetMode
  confirmHard?: boolean
  /**
   * 预览时的 HEAD（{@link ResetPreviewValue.head}）。给出时 Host 在重置前重新读取 HEAD，
   * 不一致 → `git/stale-target`（`target: 'head'`），避免按过期预览丢弃提交。
   */
  expectedHead?: string
}

export interface ResetValue {
  head: string
  version?: number
}

/** 重置预览最多列出的将丢失提交数。 */
export const RESET_PREVIEW_COMMIT_LIMIT = 50

/** `resetPreview`（读）。 */
export interface ResetPreviewRequest extends RpcRequest {
  sha: string
}

export interface ResetPreviewValue {
  /** 生成预览时的 HEAD；重置时回传为 {@link ResetRequest.expectedHead}。 */
  head: string
  /** hard 重置会丢弃的未提交改动数（已跟踪文件）。 */
  discardCount: number
  /** 从 HEAD 可达、从目标不可达的提交（最多 {@link RESET_PREVIEW_COMMIT_LIMIT} 条）。 */
  commitsLost: CommitSummary[]
  truncated: boolean
  version?: number
}

/** `fetch`（网络模式）。 */
export interface FetchRequest extends WriteRequest {
  /** null 表示 `--all`。 */
  remote: string | null
  prune: boolean
}

export interface FetchValue {
  /** 更新的 ref 数（解析 `--porcelain`；Git <2.41 无该选项时省略）。 */
  updatedRefs?: number
  version?: number
}

export type PullMode = 'merge' | 'rebase'

/** `pull`：与 A2 `pullForPush` 共用实现（`pullForPush` 保留为别名）。 */
export interface PullRequest extends SmartWriteRequest {
  remote: string
  branch: string
  mode: PullMode
}

/** `updateProject`：需要 upstream（无 → `git/invalid-payload` + `details.reason: 'no-upstream'`）。 */
export interface UpdateProjectRequest extends SmartWriteRequest {
  mode: PullMode
}

/** `resetToRemote`：上游被强推后硬重置到 upstream；有未提交改动 → `git/dirty-worktree`（不提供贮藏）。 */
export interface ResetToRemoteRequest extends WriteRequest {
  /** 默认 true：先建 `backup/<branch>-<YYYYMMDD-HHmmss>`（重名追加 `-2`）。 */
  backup?: boolean
}

export interface ResetToRemoteValue {
  head: string
  backupBranch?: string
  version?: number
}

// --- 贮藏（T5） -----------------------------------------------------------------

/** 超过该条数时贮藏列表省略 `fileCount`。 */
export const STASH_FILE_COUNT_LIMIT = 50

export interface StashEntry {
  /** 贮藏提交 sha（贮藏操作一律按 sha 定位）。 */
  sha: string
  /** 当前的 `stash@{n}` 序号（只用于显示）。 */
  index: number
  message: string
  /** 来源分支（从 `WIP on <branch>:` / `On <branch>:` 解析）；解析不到为 null。 */
  branch: string | null
  /** ISO 8601。 */
  date: string
  /** 已跟踪改动文件数；条目超过 {@link STASH_FILE_COUNT_LIMIT} 时省略。 */
  fileCount?: number
}

/** `stashList`（读，请求只带 sessionId）。 */
export interface StashListValue {
  entries: StashEntry[]
  version?: number
}

/** `stashFiles`（读）。 */
export interface StashFilesRequest extends RpcRequest {
  sha: string
}

/**
 * 贮藏内容。预览 diff 复用 `diff` 端点 `scope: 'commit'`：已跟踪文件传 `sha` + `parent: parentSha`；
 * 未跟踪文件传 `sha: untrackedSha`（根提交，全部为新增）。
 */
export interface StashFilesValue {
  sha: string
  /** 贮藏的第一父（贮藏时的 HEAD），解析后的完整 sha。 */
  parentSha: string
  /** 第三父（`-u` 贮藏的未跟踪文件提交），没有时为 null。 */
  untrackedSha: string | null
  files: CommitFileEntry[]
  untracked: FileEntry[]
  /** T5 追加：任一列表超过 2000 个文件被截断（与提交详情同一上限）；未截断时省略。 */
  truncated?: boolean
  version?: number
}

/** `stashCreate`：无改动 → `git/invalid-payload` + `details.reason: 'nothing-to-stash'`。 */
export interface StashCreateRequest extends WriteRequest {
  /** 省略时 Host 生成 `WIP on <branch>: <short> <subject>`。 */
  message?: string
  includeUntracked: boolean
  keepIndex: boolean
}

export interface StashCreateValue {
  sha: string
  message: string
  version?: number
}

/** `stashApply`：按 sha 定位（找不到 → `git/stale-target`）；冲突 → `git/conflict` + `stashKept: true`。 */
export interface StashApplyRequest extends WriteRequest {
  sha: string
  /** true：应用成功后删除该贮藏。 */
  pop: boolean
}

export interface StashApplyValue {
  sha: string
  /** 贮藏已删除（pop 成功）。 */
  dropped: boolean
  /** 暂存状态也已恢复（`--index` 成功；失败退回不带 `--index` 时为 false）。 */
  indexRestored: boolean
  version?: number
}

/** `stashDrop`：按 sha 定位（找不到 → `git/stale-target`）。 */
export interface StashDropRequest extends WriteRequest {
  sha: string
}

export interface StashDropValue {
  sha: string
  version?: number
}

// --- 端点 → 请求/响应 ---------------------------------------------------------

/**
 * 每个端点的请求与响应类型（编译期穷举 {@link RpcEndpoint}，漏登记会报错）。
 * 客户端据此给 `call(endpoint, payload)` 推导类型。
 */
export interface RpcEndpointTypes {
  bootstrap: { request: RpcRequest; value: BootstrapValue }
  status: { request: RpcRequest; value: StatusValue }
  log: { request: LogRequest; value: LogValue }
  branches: { request: RpcRequest; value: BranchesValue }
  refs: { request: RpcRequest; value: RefsValue }
  commit: { request: CommitRequest; value: CommitDetailValue }
  diff: { request: DiffRequest; value: DiffFileValue }
  console: { request: RpcRequest; value: ConsoleValue }
  commitFiles: { request: CommitFilesRequest; value: CommitResultValue }
  amendMessage: { request: AmendMessageRequest; value: CommitResultValue }
  rollback: { request: RollbackRequest; value: RollbackValue }
  addToVcs: { request: AddToVcsRequest; value: AddToVcsValue }
  pushPreview: { request: RpcRequest; value: PushPreviewValue }
  push: { request: PushRequest; value: PushValue }
  pullForPush: { request: PullForPushRequest; value: PullForPushValue }
  operationState: { request: RpcRequest; value: OperationStateValue }
  conflictCommand: { request: RpcRequest; value: ConflictCommandValue }
  resetPreview: { request: ResetPreviewRequest; value: ResetPreviewValue }
  stashList: { request: RpcRequest; value: StashListValue }
  stashFiles: { request: StashFilesRequest; value: StashFilesValue }
  operationControl: { request: OperationControlRequest; value: OperationControlValue }
  operationCommit: { request: OperationCommitRequest; value: OperationCommitValue }
  resolveConflict: { request: ResolveConflictRequest; value: ResolveConflictValue }
  checkout: { request: CheckoutRequest; value: CheckoutValue }
  createBranch: { request: CreateBranchRequest; value: CreateBranchValue }
  renameBranch: { request: RenameBranchRequest; value: RenameBranchValue }
  deleteBranch: { request: DeleteBranchRequest; value: DeleteBranchValue }
  merge: { request: MergeRequest; value: IntegrateValue }
  rebase: { request: RebaseRequest; value: IntegrateValue }
  cherryPick: { request: CherryPickRequest; value: IntegrateValue }
  revertCommit: { request: RevertCommitRequest; value: IntegrateValue }
  reset: { request: ResetRequest; value: ResetValue }
  fetch: { request: FetchRequest; value: FetchValue }
  pull: { request: PullRequest; value: IntegrateValue }
  updateProject: { request: UpdateProjectRequest; value: IntegrateValue }
  resetToRemote: { request: ResetToRemoteRequest; value: ResetToRemoteValue }
  stashCreate: { request: StashCreateRequest; value: StashCreateValue }
  stashApply: { request: StashApplyRequest; value: StashApplyValue }
  stashDrop: { request: StashDropRequest; value: StashDropValue }
}

/** 编译期检查：{@link RpcEndpointTypes} 恰好覆盖 {@link RpcEndpoint}，写端点请求都带 requestId。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const RPC_ENDPOINT_TYPES_COMPLETE: Exact<keyof RpcEndpointTypes, RpcEndpoint> = true
export const WRITE_REQUESTS_CARRY_REQUEST_ID: RpcEndpointTypes[WriteEndpoint]['request'] extends WriteRequest
  ? true
  : false = true
