// B1 T7 resolved files in the merge window (Review Changes). `mergeFile` gives the three sides from
// resolve-undo and the worktree hash, but not the worktree text, so the window explains the worktree:
// 1. replay: the automatic merge (applyNonConflicting('all') + resolveSimple) or a whole-file take
//    whose Result hashes to the worktree blob keeps its chunk states;
// 2. rebuild: HEAD (= ours, stage 2) + the staged diff + the worktree diff, verified by the hash, is
//    the Result with every chunk edited.
// Pure; the git blob hash is a small SHA-1 (crypto.subtle is async and absent outside secure contexts).
import type { DiffFileValue } from '../../shared/protocol.ts'
import { splitLines } from './line-diff.ts'
import { acceptFile, autoMerge, createModel } from './merge-model.ts'
import type { MergeModel, MergeTexts } from './merge-model.ts'

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}

/** SHA-1 of `bytes` as lowercase hex (FIPS 180-4). */
export function sha1Hex(bytes: Uint8Array): string {
  const length = bytes.length
  const blocks = Math.ceil((length + 9) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000))
  view.setUint32(padded.length - 4, (length * 8) >>> 0)
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Int32Array(80)
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(block * 64 + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1)
    let [a, b, c, d, e] = h as [number, number, number, number, number]
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (rotl(a, 5) + f + e + k + w[i]!) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = next
    }
    h[0] = (h[0]! + a) | 0
    h[1] = (h[1]! + b) | 0
    h[2] = (h[2]! + c) | 0
    h[3] = (h[3]! + d) | 0
    h[4] = (h[4]! + e) | 0
  }
  return h.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

/** `git hash-object` of `text` (UTF-8, no filters): the id `mergeFile` reports as `worktreeSha`. */
export function gitBlobSha(text: string): string {
  const body = new TextEncoder().encode(text)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)
  const bytes = new Uint8Array(header.length + body.length)
  bytes.set(header)
  bytes.set(body, header.length)
  return sha1Hex(bytes)
}

/**
 * The model whose Result is the worktree file, when a replay explains it: the automatic merge first,
 * then taking ours / theirs for the whole file. Null when none hashes to `worktreeSha`.
 */
export function replayResolved(texts: MergeTexts, worktreeSha: string | null): MergeModel | null {
  if (worktreeSha === null) return null
  const auto = autoMerge(texts)
  if (gitBlobSha(auto.result) === worktreeSha) return auto
  const fresh = createModel(texts)
  for (const side of ['left', 'right'] as const) {
    const taken = acceptFile(fresh, side)
    if (gitBlobSha(taken.result) === worktreeSha) return taken
  }
  return null
}

/**
 * `text` patched with the hunks of `diff` (old side = `text`). The diff parser drops "\ No newline at
 * end of file", so a result ending in a newline also yields the variant without it. Null when the
 * diff is binary / truncated or its context does not match.
 */
function patchVariants(text: string, diff: DiffFileValue): string[] | null {
  if (diff.binary || diff.truncated) return null
  if (diff.hunks.length === 0) return [text]
  const lines = splitLines(text)
  const out: string[] = []
  let pos = 0
  for (const hunk of diff.hunks) {
    // `-5,0` inserts after line 5; otherwise the hunk starts at line `oldStart` (1-based).
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < pos || start > lines.length) return null
    out.push(...lines.slice(pos, start))
    pos = start
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        out.push(`${line.text}\n`)
        continue
      }
      const old = lines[pos]
      if (old === undefined || (old.endsWith('\n') ? old.slice(0, -1) : old) !== line.text) return null
      if (line.type === 'context') out.push(old)
      pos++
    }
  }
  out.push(...lines.slice(pos))
  const joined = out.join('')
  return joined.endsWith('\n') ? [joined, joined.slice(0, -1)] : [joined]
}

/**
 * The worktree text of a resolved file: HEAD (= ours, stage 2 of the operation) patched with the
 * staged diff (HEAD → index) and the worktree diff (index → worktree), accepted only when it hashes
 * to `worktreeSha`. Null when it cannot be rebuilt exactly.
 */
export function rebuildWorktree(ours: string, staged: DiffFileValue, worktree: DiffFileValue, worktreeSha: string | null): string | null {
  if (worktreeSha === null) return null
  const index = patchVariants(ours, staged)
  if (index === null) return null
  for (const candidate of index) {
    for (const text of patchVariants(candidate, worktree) ?? []) {
      if (gitBlobSha(text) === worktreeSha) return text
    }
  }
  return null
}
