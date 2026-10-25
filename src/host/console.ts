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
  durationMs: number
  exitCode: number | null
  stdout: string
  stderr: string
  cancelled?: boolean | undefined
  timedOut?: boolean | undefined
  /** 上游（subprocess 收集窗口）已经丢过字节时的提示。 */
  stdoutTruncated?: boolean | undefined
  stderrTruncated?: boolean | undefined
}

/** Git 控制台数据源：记录入口 + 只读快照。 */
export interface GitConsole {
  record: (input: GitConsoleInput) => void
  /** 按时间顺序（旧 → 新）返回当前缓冲；返回新数组，调用方可随意修改。 */
  recent: () => ConsoleValue
}

export interface GitConsoleOptions {
  /** 环形缓冲条数，默认 {@link CONSOLE_BUFFER_SIZE}。 */
  size?: number | undefined
  /** 单条 stdout/stderr 的字节上限，默认 {@link CONSOLE_OUTPUT_MAX_BYTES}。 */
  outputMaxBytes?: number | undefined
  /** 可注入时钟（毫秒），默认 Date.now；只用于 `at`。 */
  now?: (() => number) | undefined
}

/** URL 里的 userinfo（`scheme://user[:token]@host`）替换为 `***`。 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi

/** 脱敏任意文本中的 URL 凭据；不是 URL 的 `@` 保持原样（如 scp 风格 remote）。 */
export function redactCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1***@')
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
    records.push(entry)
    while (records.length > size) {
      records.shift()
      dropped += 1
    }
  }

  const recent = (): ConsoleValue => ({
    records: records.map((record) => ({ ...record, argv: [...record.argv] })),
    // truncated 表示历史记录已因环形缓冲上限被丢弃（单条截断另有 per-record 标记）。
    truncated: dropped > 0,
  })

  return { record, recent }
}
