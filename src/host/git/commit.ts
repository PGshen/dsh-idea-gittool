// 提交详情读取（A1，产品设计 §9.2）：
// - sha 先做形状校验（4–64 位 hex），再 `rev-parse --verify <sha>^{commit}` 解析成完整 sha；
// - 元数据：一条 `log --no-walk=unsorted <sha> <sha>^@` 同时取本提交与各父提交的主题；
// - 变更文件：每个父提交一条 `diff-tree -r -z -M --raw --numstat`（状态 + 增删行数一次拿齐）；
// - refs：`for-each-ref --points-at <sha>`（含带注释标签的 peeled 匹配）。

import type {
  CommitDetailValue,
  CommitFileEntry,
  CommitParentValue,
  FileStatusCode,
  RefEntry,
} from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { REF_FORMAT, REF_NAMESPACES, compareRefs, parseRefRecord, splitForEachRef } from './refs.ts'

/** Per-group file cap; beyond it `truncated` is set and the prefix is kept. */
export const COMMIT_FILE_LIMIT = 2000

const SHA_PATTERN = /^[0-9a-fA-F]{4,64}$/
const RECORD_SEPARATOR = '\u001e'
/** sha, short sha, parents, author name/email/date, committer name/email/date, subject, body. */
const DETAIL_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join('%x00')
const DETAIL_FIELDS = 11

export interface ReadCommitOptions {
  signal?: AbortSignal | undefined
  /** File cap override (tests); defaults to {@link COMMIT_FILE_LIMIT}. */
  fileLimit?: number | undefined
}

/** One changed path from `--raw` merged with its `--numstat` counts. */
export interface RawChange {
  status: FileStatusCode
  path: string
  origPath?: string
  oldSha: string
  newSha: string
  oldMode: string
  newMode: string
  additions?: number
  deletions?: number
  binary: boolean
}

/**
 * Validate a client-supplied revision and resolve it to a full commit sha.
 * Shape errors and unknown objects are `git/invalid-payload`; repository failures keep their code.
 */
export async function resolveCommitSha(
  run: GitRunner,
  cwd: string,
  sha: unknown,
  signal?: AbortSignal,
  label = 'sha',
): Promise<string> {
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw invalidPayload(`${label} must be 4-64 hexadecimal characters`, {})
  }
  const result = await run([...GIT_BASE_ARGV, 'rev-parse', '-q', '--verify', `${sha}^{commit}`], {
    cwd,
    signal,
  })
  if (result.exitCode === 0) {
    const full = result.stdout.trim()
    if (full !== '') return full
  }
  if (result.exitCode === 1) throw invalidPayload(`${label} does not name a commit`, { [label]: sha })
  throw failureFromExit(result, 'git rev-parse')
}

/** Parse NUL-separated `--raw --numstat -z` output (raw records first, numstat after). */
export function parseRawNumstat(raw: string): RawChange[] {
  const tokens = raw.split('\0')
  const changes: RawChange[] = []
  const byPath = new Map<string, RawChange>()
  let index = 0

  while (index < tokens.length && (tokens[index] ?? '').startsWith(':')) {
    const meta = (tokens[index] ?? '').slice(1).split(' ')
    index += 1
    const letter = (meta[4] ?? 'M').charAt(0)
    const status = toStatus(letter)
    const first = tokens[index] ?? ''
    index += 1
    const change: RawChange = {
      status,
      path: first,
      oldMode: meta[0] ?? '',
      newMode: meta[1] ?? '',
      oldSha: meta[2] ?? '',
      newSha: meta[3] ?? '',
      binary: false,
    }
    if (letter === 'R' || letter === 'C') {
      change.origPath = first
      change.path = tokens[index] ?? ''
      index += 1
    }
    changes.push(change)
    byPath.set(change.path, change)
  }

  while (index < tokens.length) {
    const head = tokens[index] ?? ''
    index += 1
    if (head === '') continue
    const parts = head.split('\t')
    let path = parts[2] ?? ''
    if (parts.length >= 3 && path === '') {
      // Rename/copy: `add\tdel\t\0old\0new\0`.
      index += 1
      path = tokens[index] ?? ''
      index += 1
    }
    const change = byPath.get(path)
    if (change === undefined) continue
    if (parts[0] === '-' && parts[1] === '-') {
      change.binary = true
    } else {
      change.additions = Number(parts[0])
      change.deletions = Number(parts[1])
    }
  }
  return changes
}

/** Read a commit's metadata, refs and changed files (grouped by parent for merges). */
export async function readCommit(
  run: GitRunner,
  cwd: string,
  sha: unknown,
  options: ReadCommitOptions = {},
): Promise<CommitDetailValue> {
  const { signal } = options
  const limit = options.fileLimit ?? COMMIT_FILE_LIMIT
  const full = await resolveCommitSha(run, cwd, sha, signal)

  const [logResult, refsResult] = await Promise.all([
    run(
      [
        ...GIT_BASE_ARGV,
        'log',
        '--no-walk=unsorted',
        '--no-show-signature',
        '--no-notes',
        `--format=format:${DETAIL_FORMAT}%x1e`,
        full,
        `${full}^@`,
        '--',
      ],
      { cwd, signal },
    ),
    run(
      [
        ...GIT_BASE_ARGV,
        'for-each-ref',
        `--points-at=${full}`,
        `--format=${REF_FORMAT}`,
        ...REF_NAMESPACES,
      ],
      { cwd, signal },
    ),
  ])
  if (logResult.exitCode !== 0) throw failureFromExit(logResult, 'git log')
  if (refsResult.exitCode !== 0) throw failureFromExit(refsResult, 'git for-each-ref')

  const records = logResult.stdout
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
  const own = records[0]?.split('\0')
  if (own === undefined || own.length < DETAIL_FIELDS) {
    throw new GitCommandFailure('git/exec-failed', 'unparseable git log record', {
      record: (records[0] ?? '').slice(0, 200),
    })
  }
  const parentShas = (own[2] ?? '') === '' ? [] : (own[2] ?? '').split(' ')
  const parentSubjects = new Map<string, { shortSha: string; subject: string }>()
  for (const record of records.slice(1)) {
    const fields = record.split('\0')
    parentSubjects.set(fields[0] ?? '', { shortSha: fields[1] ?? '', subject: fields[9] ?? '' })
  }
  const parents: CommitParentValue[] = parentShas.map((parent) => ({
    sha: parent,
    shortSha: parentSubjects.get(parent)?.shortSha ?? parent.slice(0, 7),
    subject: parentSubjects.get(parent)?.subject ?? '',
  }))

  const refs: RefEntry[] = []
  for (const fields of splitForEachRef(refsResult.stdout)) {
    if ((fields[3] ?? '') !== '') continue
    const entry = parseRefRecord(fields)
    if (entry !== undefined && entry.sha === full) refs.push(entry)
  }
  refs.sort(compareRefs)

  // Root commits diff against the empty tree; every other commit once per parent.
  const bases: (string | null)[] = parentShas.length === 0 ? [null] : parentShas
  const groups = await Promise.all(
    bases.map(async (parent) => {
      const result = await run(
        [
          ...GIT_BASE_ARGV,
          'diff-tree',
          '-r',
          '-z',
          '-M',
          '--raw',
          '--numstat',
          '--no-abbrev',
          '--no-commit-id',
          '--no-ext-diff',
          ...(parent === null ? ['--root', full] : [parent, full]),
          '--',
        ],
        { cwd, signal },
      )
      if (result.exitCode !== 0) throw failureFromExit(result, 'git diff-tree')
      return { parent, changes: parseRawNumstat(result.stdout) }
    }),
  )

  let truncated = false
  const grouped = groups.map(({ parent, changes }) => {
    if (changes.length > limit) truncated = true
    const files = changes.slice(0, limit).map((change) => toFileEntry(change, parent))
    return { parentSha: parent, files }
  })

  const value: CommitDetailValue = {
    sha: full,
    shortSha: own[1] ?? full.slice(0, 7),
    parents,
    author: { name: own[3] ?? '', email: own[4] ?? '', date: own[5] ?? '' },
    committer: { name: own[6] ?? '', email: own[7] ?? '', date: own[8] ?? '' },
    subject: own[9] ?? '',
    // The body is the remainder; trailing newlines from %b are noise.
    body: own.slice(10).join('\0').replace(/\n+$/, ''),
    refs,
    files: grouped[0]?.files ?? [],
    truncated,
  }
  if (parentShas.length > 1) {
    value.parentGroups = grouped.map((group) => ({
      parentSha: group.parentSha ?? '',
      files: group.files,
    }))
  }
  return value
}

function toFileEntry(change: RawChange, parent: string | null): CommitFileEntry {
  const entry: CommitFileEntry = { path: change.path, status: change.status }
  if (change.origPath !== undefined) entry.origPath = change.origPath
  if (change.additions !== undefined) entry.additions = change.additions
  if (change.deletions !== undefined) entry.deletions = change.deletions
  if (parent !== null) entry.parentSha = parent
  return entry
}

function toStatus(letter: string): FileStatusCode {
  switch (letter) {
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return letter
    default:
      return 'M'
  }
}

function invalidPayload(message: string, details: Record<string, unknown>): GitCommandFailure {
  return new GitCommandFailure('git/invalid-payload', message, details)
}
