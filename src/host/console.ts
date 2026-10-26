// Git 控制台的进程内环形缓冲（产品设计 §12、AC10）：
// - 记录每次 git 调用的 argv / 耗时 / 退出码 / stdout+stderr 摘要；
// - 凭据脱敏（URL 里的 `user:token@` → `***`）；
// - 单条输出各 ≤64KB，超出从头截断并标记；
// - 只读展示用，不提供输入通道。
//
// 记录由 git-executor 的 instrumentGitRunner 统一写入，读写命令都记。

import type { ConsoleRecord, ConsoleValue } from '../shared/protocol.ts'
import { CONSOLE_BUFFER_SIZE, CONSOLE_OUTPUT_MAX_BYTES } from '../shared/protocol.ts'

/** 一条待记录的调用事实；时间与截断标记由 {@link GitConsole.record} 补齐。 */
export interface GitConsoleInput {
  /** 实际 argv（不含可执行文件路径）；记录时做凭据脱敏。 */
  argv: readonly string[]
  /** 执行目录（用于按仓库过滤）。 */
  cwd?: string | undefined
  durationMs: number
  exitCode: number | null
  stdout: string
  stderr: string
  cancelled?: boolean | undefined
  timedOut?: boolean | undefined
  /** 上游（subprocess 收集窗口）已经丢过字节时的提示。 */
  stdoutTruncated?: boolean | undefined
  stderrTruncated?: boolean | undefined
  /** 经 stdin 传给 git 的字节数（A3）；内容本身（路径、提交信息）永不记录。 */
  stdinBytes?: number | undefined
}

/** Git 控制台数据源：记录入口 + 只读快照。 */
export interface GitConsole {
  record: (input: GitConsoleInput) => void
  /**
   * 按时间顺序（旧 → 新）返回当前缓冲；返回新数组，调用方可随意修改。
   * 传 `root` 时只返回在该仓库根（含子目录）里执行的记录。
   */
  recent: (filter?: { root?: string | undefined }) => ConsoleValue
}

export interface GitConsoleOptions {
  /** 环形缓冲条数，默认 {@link CONSOLE_BUFFER_SIZE}。 */
  size?: number | undefined
  /** 单条 stdout/stderr 的字节上限，默认 {@link CONSOLE_OUTPUT_MAX_BYTES}。 */
  outputMaxBytes?: number | undefined
  /** 可注入时钟（毫秒），默认 Date.now；只用于 `at`。 */
  now?: (() => number) | undefined
}

/** 协议名（`https`、`ssh` …）最长 32 个字符，userinfo 最长 512 个字符。 */
const SCHEME_BEFORE_SEPARATOR = /[a-z][a-z0-9+.-]{0,31}$/i
const SCHEME_MAX = 32
const USERINFO_MAX = 512

/**
 * 脱敏任意文本中的 URL 凭据（`scheme://user[:token]@host` → `scheme://***@host`）；
 * 不是 URL 的 `@` 保持原样（如 scp 风格 remote）。
 *
 * 只在每个 `://` 附近的小窗口里检查，整体线性：一条全局正则在长串字母
 * （base64、压缩代码）上是平方复杂度，2MB 输出会阻塞 Host 主线程数十分钟
 * （A1 合并前关口发现）。
 */
export function redactCredentials(text: string): string {
  let result = ''
  let copied = 0
  let from = 0
  for (;;) {
    const separator = text.indexOf('://', from)
    if (separator < 0) break
    const userinfoStart = separator + 3
    from = userinfoStart
    if (!SCHEME_BEFORE_SEPARATOR.test(text.slice(Math.max(copied, separator - SCHEME_MAX), separator))) continue
    const at = userinfoEnd(text, userinfoStart)
    if (at < 0) continue
    result += `${text.slice(copied, userinfoStart)}***@`
    copied = at + 1
    from = copied
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/** userinfo 结束处 `@` 的下标；遇到空白、`/` 或超过上限则不是凭据，返回 -1。 */
function userinfoEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + USERINFO_MAX + 1)
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (char === '@') return index > start ? index : -1
    if (char === '/' || char === undefined || /\s/.test(char)) return -1
  }
  return -1
}

/** 保留前缀并按 UTF-8 字节截断，绝不切出半个多字节字符。 */
export function truncateConsoleOutput(
  text: string,
  maxBytes: number = CONSOLE_OUTPUT_MAX_BYTES,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  // 从上限处回退到合法的 UTF-8 字符边界（最多回退 3 字节）。
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

/** 创建进程内控制台缓冲。纯内存、无定时器，可注入时钟便于测试。 */
export function createGitConsole(options: GitConsoleOptions = {}): GitConsole {
  const size = Math.max(1, Math.floor(options.size ?? CONSOLE_BUFFER_SIZE))
  const outputMaxBytes = options.outputMaxBytes ?? CONSOLE_OUTPUT_MAX_BYTES
  const now = options.now ?? Date.now
  const records: ConsoleRecord[] = []
  let dropped = 0

  const record = (input: GitConsoleInput): void => {
    const stdout = truncateConsoleOutput(redactCredentials(input.stdout), outputMaxBytes)
    const stderr = truncateConsoleOutput(redactCredentials(input.stderr), outputMaxBytes)
    const entry: ConsoleRecord = {
      at: new Date(now()).toISOString(),
      argv: input.argv.map((argument) => redactCredentials(argument)),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      exitCode: input.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated || input.stdoutTruncated === true,
      stderrTruncated: stderr.truncated || input.stderrTruncated === true,
    }
    if (input.cancelled === true) entry.cancelled = true
    if (input.timedOut === true) entry.timedOut = true
    if (input.cwd !== undefined) entry.cwd = input.cwd
    if (input.stdinBytes !== undefined) entry.stdinBytes = input.stdinBytes
    // 轮询会反复执行同样的读命令：成功且输出一致的重复命令折叠成一条（移到末尾、计数），
    // 否则 3s 一轮的噪音会很快冲掉用户真正想排查的记录。失败永远单独保留。
    if (entry.exitCode === 0) {
      const previous = records.findIndex((record) => isSameSuccess(record, entry))
      if (previous >= 0) {
        const [folded] = records.splice(previous, 1)
        entry.repeat = (folded?.repeat ?? 1) + 1
      }
    }
    records.push(entry)
    while (records.length > size) {
      records.shift()
      dropped += 1
    }
  }

  const recent = (filter: { root?: string | undefined } = {}): ConsoleValue => ({
    records: records
      .filter((record) => filter.root === undefined || isWithin(record.cwd, filter.root))
      .map((record) => ({ ...record, argv: [...record.argv] })),
    // truncated 表示历史记录已因环形缓冲上限被丢弃（单条截断另有 per-record 标记）。
    truncated: dropped > 0,
  })

  return { record, recent }
}

function isSameSuccess(left: ConsoleRecord, right: ConsoleRecord): boolean {
  return left.exitCode === 0
    && left.cwd === right.cwd
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.stdinBytes === right.stdinBytes
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index])
}

/** `cwd` 是否位于仓库根内（按路径段比较，`/repo/ab` 不属于 `/repo/a`）。 */
function isWithin(cwd: string | undefined, root: string): boolean {
  if (cwd === undefined) return false
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return cwd === base || cwd.startsWith(`${base}/`)
}
