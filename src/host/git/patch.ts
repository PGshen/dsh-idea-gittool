// Patches (plan b3b): export commits with `format-patch --stdout` (read) and apply a pasted or chosen
// patch (write): mbox → `git am --3way`, plain diff → `git apply --check --index` then `git apply --index`
// (no `--3way` for plain diffs: a diff that does not apply cleanly is refused, leaving index and worktree untouched).
import type { ApplyPatchValue, FormatPatchValue } from '../../shared/protocol.ts'
import { APPLY_PATCH_MAX_BYTES, FORMAT_PATCH_MAX_COMMITS } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { assertNoOperation, invalidPayload, optionalBoolean, outputSummary, payloadRecord, redactedFailure } from './write-support.ts'

/** A `git format-patch` mail header line: the mailbox format `git am` reads. */
const MBOX_HEADER = /^From [0-9a-f]{40} /gmu

/** Download name: `<short sha>-<subject>.patch`, or `<n>-commits.patch`. */
export function patchFileName(commits: readonly { sha: string; subject: string }[]): string {
  const [only] = commits
  if (commits.length !== 1 || only === undefined) return `${String(commits.length)}-commits.patch`
  const slug = only.subject.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50) || 'commit'
  return `${only.sha.slice(0, 7)}-${slug}.patch`
}

/** `format-patch --stdout` of the commits, oldest first; merge commits are refused (format-patch skips them). */
export async function readFormatPatch(
  run: GitRunner,
  cwd: string,
  shas: readonly string[],
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<FormatPatchValue, 'version'>> {
  const git = async (args: readonly string[], stdoutMaxBytes?: number): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], { cwd, signal: options.signal, ...(stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes }) })
  const listing = await git(['log', '--no-walk=sorted', '--format=%H%x00%P%x00%s', ...shas, '--'])
  if (listing.exitCode !== 0) throw invalidPayload('shas must name commits', {})
  const listed = listing.stdout.split('\n').filter(line => line !== '').map(line => {
    const [sha = '', parents = '', subject = ''] = line.split('\0')
    return { sha, parents: parents === '' ? [] : parents.split(' '), subject }
  })
  // Oldest first by ancestry, not by date: commits made within one second tie on date.
  const depth = new Map<string, number>()
  for (const commit of listed) {
    const count = await git(['rev-list', '--count', commit.sha, '--'])
    if (count.exitCode !== 0) throw failureFromExit(count, 'git rev-list')
    depth.set(commit.sha, Number(count.stdout.trim()))
  }
  const commits = [...listed].sort((a, b) => (depth.get(a.sha) ?? 0) - (depth.get(b.sha) ?? 0))
  if (commits.length !== shas.length) throw invalidPayload('shas must name distinct commits', {})
  const merge = commits.find(commit => commit.parents.length > 1)
  if (merge !== undefined) throw invalidPayload('merge commits cannot be exported as patches', { reason: 'merge-commit', sha: merge.sha })
  let patch = ''
  // One format-patch per commit (the picks need not be contiguous); several commits are numbered
  // `[PATCH n/m]` like `format-patch --numbered` over a range, a single one stays `[PATCH]`.
  for (const [index, commit] of commits.entries()) {
    const numbering = commits.length > 1
      ? ['--no-numbered', `--subject-prefix=PATCH ${String(index + 1)}/${String(commits.length)}`]
      : []
    const result = await git(['format-patch', '--stdout', ...numbering, '-1', commit.sha], APPLY_PATCH_MAX_BYTES)
    if (result.exitCode !== 0) throw failureFromExit(result, 'git format-patch')
    patch += result.stdout
    if (Buffer.byteLength(patch, 'utf8') > APPLY_PATCH_MAX_BYTES) {
      throw new GitCommandFailure('git/output-too-large', 'the patch is too large', { limit: APPLY_PATCH_MAX_BYTES })
    }
  }
  return { patch, fileName: patchFileName(commits) }
}

/** Paths a patch touches (`apply --numstat -z`; renames report the new path). */
async function patchFiles(ctx: WriteContext, patch: string): Promise<string[]> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'apply', '--numstat', '-z'], { mode: 'read', stdin: patch })
  if (result.exitCode !== 0) {
    throw invalidPayload('the text is not a patch git can read', { reason: 'not-a-patch', output: outputSummary(result) })
  }
  const files = new Set<string>()
  const tokens = result.stdout.split('\0')
  for (let at = 0; at < tokens.length; at += 1) {
    const fields = (tokens[at] ?? '').split('\t')
    if (fields.length < 3) continue
    const path = fields[2] ?? ''
    if (path === '') {
      // Rename: `<add>\t<del>\t\0<old>\0<new>\0`.
      const renamed = tokens[at + 2]
      if (renamed !== undefined && renamed !== '') files.add(renamed)
      at += 2
    } else {
      files.add(path)
    }
  }
  return [...files].sort()
}

function applyFailure(result: GitRunResult, label: string): GitCommandFailure {
  const failure = redactedFailure(result, label)
  return new GitCommandFailure(failure.code, failure.message, { ...failure.details, output: outputSummary(result) })
}

/** Validated `formatPatch` shas (1–{@link FORMAT_PATCH_MAX_COMMITS}, full, distinct). */
export function parseFormatPatchShas(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidPayload('shas must be a non-empty array')
  if (value.length > FORMAT_PATCH_MAX_COMMITS) {
    throw invalidPayload(`shas exceed ${String(FORMAT_PATCH_MAX_COMMITS)}`, { limit: FORMAT_PATCH_MAX_COMMITS })
  }
  const shas = value.map((sha, index) => parseFullSha(sha, `shas[${String(index)}]`))
  if (new Set(shas).size !== shas.length) throw invalidPayload('shas must not repeat')
  return shas
}

export interface ApplyPatchInput {
  patch: string
  check: boolean
}

export const applyPatchOperation: WriteOperation<ApplyPatchInput, Omit<ApplyPatchValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const patch = record.patch
    if (typeof patch !== 'string' || patch.trim() === '') throw invalidPayload('patch must be a non-empty string')
    if (Buffer.byteLength(patch, 'utf8') > APPLY_PATCH_MAX_BYTES) {
      throw invalidPayload(`patch exceeds ${String(APPLY_PATCH_MAX_BYTES)} bytes`, { limit: APPLY_PATCH_MAX_BYTES, reason: 'body-too-large' })
    }
    return { patch, check: optionalBoolean(record, 'check') }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const commits = input.patch.match(MBOX_HEADER)?.length ?? 0
    const format = commits > 0 ? 'mbox' : 'diff'
    const files = await patchFiles(ctx, input.patch)
    const preview: Omit<ApplyPatchValue, 'version'> = { format, files, applied: false, ...(format === 'mbox' ? { commits } : {}) }
    if (input.check) return preview
    if (format === 'diff') {
      // Check first so a patch that does not apply leaves index and worktree untouched.
      const check = await ctx.git([...GIT_BASE_ARGV, 'apply', '--check', '--index'], { stdin: input.patch })
      if (check.exitCode !== 0) throw applyFailure(check, 'git apply --check')
      const applied = await ctx.git([...GIT_BASE_ARGV, 'apply', '--index'], { stdin: input.patch })
      if (applied.exitCode !== 0) throw applyFailure(applied, 'git apply')
      return { ...preview, applied: true }
    }
    const am = await ctx.git([...GIT_BASE_ARGV, 'am', '--3way'], { stdin: input.patch })
    if (am.exitCode !== 0) {
      // Never leave a half-applied mailbox behind (plan b3b AC10).
      await ctx.git([...GIT_BASE_ARGV, 'am', '--abort'])
      throw applyFailure(am, 'git am')
    }
    return { ...preview, applied: true }
  },
}
