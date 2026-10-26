// B1 T7 resolved files in the merge window: git blob hashes, replaying the automatic steps /
// whole-file takes against the worktree hash, rebuilding the worktree text from HEAD + diffs, and
// the all-edited fallback model.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { autoMerge, counts, createModel, editedModel, isManuallyEdited } from '../../../src/client/merge/merge-model.ts'
import { gitBlobSha, rebuildWorktree, replayResolved } from '../../../src/client/merge/resolved-replay.ts'
import type { DiffFileValue, DiffHunk } from '../../../src/shared/protocol.ts'

const nodeBlobSha = (body: string): string => {
  const bytes = Buffer.from(body, 'utf8')
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex')
}

// Fixture: one left-only chunk, one simple conflict (different words of one line), one right-only.
const TEXTS = {
  base: 'a\nb\nalpha beta\nd\n',
  ours: 'a\nB\nALPHA beta\nd\n',
  theirs: 'a\nb\nalpha BETA\nd\nend\n',
}

describe('gitBlobSha', () => {
  it('matches git hash-object for empty, ASCII and multi-byte text', () => {
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    for (const body of ['中文\r\n行\n', 'x'.repeat(70), 'y'.repeat(1000) + '\u{1F600}']) {
      expect(gitBlobSha(body)).toBe(nodeBlobSha(body))
    }
  })
})

describe('replayResolved', () => {
  it('worktree equals the automatic merge: the chunk states of the replay come back', () => {
    const auto = autoMerge(TEXTS)
    const model = replayResolved(TEXTS, gitBlobSha(auto.result))
    expect(model?.result).toBe(auto.result)
    expect(model?.chunks.map(c => c.state)).toEqual(auto.chunks.map(c => c.state))
    expect(counts(model!)).toEqual({ resolved: 1, total: 1 })
  })

  it('worktree equals one side (采用 …): that side is accepted for the whole file', () => {
    const left = replayResolved(TEXTS, gitBlobSha(TEXTS.ours))
    expect(left?.result).toBe(TEXTS.ours)
    expect(left?.chunks.every(c => c.leftDone && c.rightDone)).toBe(true)
    const right = replayResolved(TEXTS, gitBlobSha(TEXTS.theirs))
    expect(right?.result).toBe(TEXTS.theirs)
  })

  it('anything else (or no worktree file) is not explained by the replay', () => {
    expect(replayResolved(TEXTS, gitBlobSha('hand made\n'))).toBeNull()
    expect(replayResolved(TEXTS, null)).toBeNull()
  })
})

describe('editedModel', () => {
  it('takes the given Result and marks every chunk edited (manually)', () => {
    const model = editedModel(createModel(TEXTS), 'hand\nmade\n')
    expect(model.result).toBe('hand\nmade\n')
    expect(model.chunks.length).toBeGreaterThan(1)
    expect(model.chunks.every(c => c.state === 'edited' && isManuallyEdited(c))).toBe(true)
    expect(model.chunks[0]?.resultRange).toEqual({ start: 0, end: 2 })
    expect(model.chunks.slice(1).every(c => c.resultRange.start === 2 && c.resultRange.end === 2)).toBe(true)
  })
})

// ---- rebuilding the worktree from HEAD (= ours) + staged diff + worktree diff ----

function diffValue(hunks: DiffHunk[], over: Partial<DiffFileValue> = {}): DiffFileValue {
  return { oldPath: 'a.txt', newPath: 'a.txt', status: 'M', binary: false, hunks, truncated: false, ...over }
}

/** A minimal unified diff of whole-file replacement `from → to` in one hunk (enough for the tests). */
function wholeHunk(from: string, to: string): DiffHunk {
  const strip = (lines: string[]): string[] => lines.map(line => line.replace(/\n$/, ''))
  const a = strip(from.match(/[^\n]*\n|[^\n]+$/g) ?? [])
  const b = strip(to.match(/[^\n]*\n|[^\n]+$/g) ?? [])
  return {
    header: `@@ -1,${a.length} +1,${b.length} @@`,
    oldStart: a.length === 0 ? 0 : 1,
    oldLines: a.length,
    newStart: b.length === 0 ? 0 : 1,
    newLines: b.length,
    lines: [...a.map(text => ({ type: 'del' as const, text })), ...b.map(text => ({ type: 'add' as const, text }))],
  }
}

describe('rebuildWorktree', () => {
  it('applies the staged and worktree hunks to HEAD and verifies the result hash', () => {
    const ours = 'one\ntwo\nthree\nfour\n'
    const staged = diffValue([{
      header: '@@ -2,2 +2,2 @@', oldStart: 2, oldLines: 2, newStart: 2, newLines: 2,
      lines: [{ type: 'del', text: 'two' }, { type: 'add', text: 'TWO' }, { type: 'context', text: 'three' }],
    }])
    const worktree = diffValue([{
      header: '@@ -4,0 +5,1 @@', oldStart: 4, oldLines: 0, newStart: 5, newLines: 1,
      lines: [{ type: 'add', text: 'five' }],
    }])
    const expected = 'one\nTWO\nthree\nfour\nfive\n'
    expect(rebuildWorktree(ours, staged, worktree, gitBlobSha(expected))).toBe(expected)
    expect(rebuildWorktree(ours, staged, worktree, gitBlobSha('other\n'))).toBeNull()
  })

  it('keeps CRLF and recovers a last line without a newline (lost by the diff parser)', () => {
    const ours = 'a\r\nb\r\n'
    const target = 'a\r\nB\r\nc'
    expect(rebuildWorktree(ours, diffValue([wholeHunk(ours, target)]), diffValue([]), gitBlobSha(target))).toBe(target)
  })

  it('no staged / worktree change: HEAD itself', () => {
    expect(rebuildWorktree('x\n', diffValue([]), diffValue([]), gitBlobSha('x\n'))).toBe('x\n')
  })

  it('binary, truncated or mismatching context: null', () => {
    const ours = 'a\nb\n'
    const hunk = wholeHunk(ours, 'c\n')
    expect(rebuildWorktree(ours, diffValue([hunk], { truncated: true }), diffValue([]), gitBlobSha('c\n'))).toBeNull()
    expect(rebuildWorktree(ours, diffValue([hunk], { binary: true }), diffValue([]), gitBlobSha('c\n'))).toBeNull()
    expect(rebuildWorktree('z\nb\n', diffValue([hunk]), diffValue([]), gitBlobSha('c\n'))).toBeNull()
  })
})
