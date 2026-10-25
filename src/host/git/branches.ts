// branches 读取（A1）：一次 `for-each-ref` 取本地/远程/标签 + upstream + ahead/behind + 是否 HEAD，
// 按 local / remote / tags 分组。HEAD 的分支名与 sha 用两条极轻的 plumbing 命令先取，
// 以便区分 unborn（有分支名、无 sha）与 detached（有 sha、无分支名）。
// 收藏（P1）暂不返回。

import type { BranchEntry, BranchesValue } from '../../shared/protocol.ts'
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { REF_NAMESPACES, REFS_ENTRY_LIMIT, compareRefs, parseRefRecord, splitForEachRef } from './refs.ts'

/** Fields: refname, objectname, peeled objectname, symref, HEAD marker, upstream, track. */
const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(symref)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
].join('%00')

export interface ReadBranchesOptions {
  signal?: AbortSignal | undefined
  /** Entry cap override (tests); defaults to {@link REFS_ENTRY_LIMIT}. */
  entryLimit?: number | undefined
}

/** Parse `ahead 1, behind 2` / `gone` / empty into counts. */
export function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track)?.[1]
  const behind = /behind (\d+)/.exec(track)?.[1]
  return { ahead: ahead === undefined ? 0 : Number(ahead), behind: behind === undefined ? 0 : Number(behind) }
}

export async function readBranches(
  run: GitRunner,
  cwd: string,
  options: ReadBranchesOptions = {},
): Promise<BranchesValue> {
  const limit = options.entryLimit ?? REFS_ENTRY_LIMIT
  const { signal } = options

  const symbolic = await run([...GIT_BASE_ARGV, 'symbolic-ref', '-q', 'HEAD'], { cwd, signal })
  // Exit 1 means detached HEAD; anything else non-zero is a real failure.
  if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) {
    throw failureFromExit(symbolic, 'git symbolic-ref')
  }
  const headRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ''
  const resolved = await run([...GIT_BASE_ARGV, 'rev-parse', '-q', '--verify', 'HEAD'], {
    cwd,
    signal,
  })
  // Exit 1 with empty output means an unborn branch.
  if (resolved.exitCode !== 0 && resolved.exitCode !== 1) {
    throw failureFromExit(resolved, 'git rev-parse')
  }
  const headSha = resolved.exitCode === 0 ? resolved.stdout.trim() || null : null
  const branch =
    headRef === '' ? null : headRef.startsWith('refs/heads/') ? headRef.slice('refs/heads/'.length) : headRef

  const result = await run(
    [...GIT_BASE_ARGV, 'for-each-ref', `--format=${BRANCH_FORMAT}`, ...REF_NAMESPACES],
    { cwd, signal },
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git for-each-ref')

  const entries: BranchEntry[] = []
  for (const fields of splitForEachRef(result.stdout)) {
    // Symbolic refs (origin/HEAD) are aliases, not branch rows.
    if ((fields[3] ?? '') !== '') continue
    const ref = parseRefRecord(fields)
    if (ref === undefined) continue
    const current = ref.kind === 'local' && ref.ref === headRef
    const entry: BranchEntry = {
      ...ref,
      head: current || (fields[4] ?? '') === '*',
      current,
      ...(ref.kind === 'local' ? parseTrack(fields[6] ?? '') : { ahead: 0, behind: 0 }),
    }
    const upstream = fields[5] ?? ''
    if (ref.kind === 'local' && upstream !== '') entry.upstream = upstream
    entries.push(entry)
  }
  entries.sort(compareRefs)

  const truncated = entries.length > limit
  const kept = truncated ? entries.slice(0, limit) : entries
  return {
    head: { branch, detached: headRef === '' && headSha !== null, sha: headSha },
    local: kept.filter((entry) => entry.kind === 'local'),
    remote: kept.filter((entry) => entry.kind === 'remote'),
    tags: kept.filter((entry) => entry.kind === 'tag'),
    truncated,
  }
}
