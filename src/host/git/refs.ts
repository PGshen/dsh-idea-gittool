// refs 读取（A1）：一次 `for-each-ref` 拉全量本地/远程/标签，按 sha 建索引，
// 供日志行 refs 胶囊与提交详情复用。符号 ref（如 `origin/HEAD`）不是真实目标，直接跳过。
// 标签取 peeled commit（%( *objectname)），否则带注释标签的 sha 会指向 tag 对象、匹配不上日志行。

import type { RefEntry, RefKind, RefsValue } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'

/** ref 条目上限；超出时 truncated 为 true（保护单响应体积）。 */
export const REFS_ENTRY_LIMIT = 5000

/** `for-each-ref` 的 NUL 分隔格式字段。 */
export const REF_FORMAT = ['%(refname)', '%(objectname)', '%(*objectname)', '%(symref)'].join('%00')

/** 一次拉取的 ref 命名空间；顺序决定同组内的稳定排序。 */
export const REF_NAMESPACES = ['refs/heads', 'refs/remotes', 'refs/tags'] as const

const KIND_ORDER: Readonly<Record<RefKind, number>> = { local: 0, remote: 1, tag: 2 }

export interface ReadRefsOptions {
  signal?: AbortSignal | undefined
  /** 条目上限覆盖（测试用）；默认 {@link REFS_ENTRY_LIMIT}。 */
  entryLimit?: number | undefined
}

/** 把 `for-each-ref` 输出按行/按 NUL 字段切开；去掉每行末尾分隔符造成的空字段。 */
export function splitForEachRef(raw: string): string[][] {
  const records: string[][] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const fields = line.split('\0')
    if (fields.at(-1) === '') fields.pop()
    records.push(fields)
  }
  return records
}

/** 按 ref 前缀判断 kind；未知命名空间返回 undefined（直接被忽略）。 */
export function refKindOf(ref: string): RefKind | undefined {
  if (ref.startsWith('refs/heads/')) return 'local'
  if (ref.startsWith('refs/remotes/')) return 'remote'
  if (ref.startsWith('refs/tags/')) return 'tag'
  return undefined
}

/** 展示名：本地/标签去命名空间前缀，远程保留 `origin/main` 形式。 */
export function refDisplayName(ref: string, kind: RefKind): string {
  if (kind === 'local') return ref.slice('refs/heads/'.length)
  if (kind === 'tag') return ref.slice('refs/tags/'.length)
  return ref.slice('refs/remotes/'.length)
}

/** 解析 `for-each-ref` 的 ref 行；未知命名空间与空字段都按跳过/空值处理。 */
export function parseRefRecord(fields: readonly string[]): RefEntry | undefined {
  const ref = fields[0]
  if (ref === undefined || ref === '') return undefined
  const kind = refKindOf(ref)
  if (kind === undefined) return undefined
  const objectSha = fields[1] ?? ''
  const peeled = fields[2] ?? ''
  const sha = peeled !== '' ? peeled : objectSha
  if (sha === '') return undefined
  return { ref, name: refDisplayName(ref, kind), kind, sha }
}

/** 拉取全部 ref 并按 sha 建索引。 */
export async function readRefs(
  run: GitRunner,
  cwd: string,
  options: ReadRefsOptions = {},
): Promise<RefsValue> {
  const limit = options.entryLimit ?? REFS_ENTRY_LIMIT
  const result = await run(
    [...GIT_BASE_ARGV, 'for-each-ref', `--format=${REF_FORMAT}`, ...REF_NAMESPACES],
    { cwd, signal: options.signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git for-each-ref')

  const entries: RefEntry[] = []
  for (const fields of splitForEachRef(result.stdout)) {
    // `%(symref)` 非空表示这是符号 ref（origin/HEAD、refs/remotes/*/HEAD），不是真实目标。
    if ((fields[3] ?? '') !== '') continue
    const entry = parseRefRecord(fields)
    if (entry !== undefined) entries.push(entry)
  }
  entries.sort(compareRefs)

  const truncated = entries.length > limit
  const kept = truncated ? entries.slice(0, limit) : entries
  const bySha: Record<string, RefEntry[]> = {}
  for (const entry of kept) {
    const bucket = bySha[entry.sha]
    if (bucket === undefined) bySha[entry.sha] = [entry]
    else bucket.push(entry)
  }
  return { bySha, truncated }
}

/** Stable order: kind (local, remote, tag), then display name. */
export function compareRefs(left: RefEntry, right: RefEntry): number {
  const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  if (byKind !== 0) return byKind
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}
