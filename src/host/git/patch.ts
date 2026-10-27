// Patches (plan b3b): export commits with `format-patch --stdout` (read) and apply a pasted or chosen
// patch (write): mbox → `git am --3way`, plain diff → `git apply --3way --index`.
import type { ApplyPatchValue } from '../../shared/protocol.ts'
import { APPLY_PATCH_MAX_BYTES, FORMAT_PATCH_MAX_COMMITS } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { GitCommandFailure } from '../git-executor.ts'
import { parseFullSha } from './integrate.ts'
import { invalidPayload, optionalBoolean, payloadRecord } from './write-support.ts'

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

  run() {
    return Promise.reject(new GitCommandFailure('git/exec-failed', 'not implemented', {}))
  },
}
