// 写能力门禁（可行性调研 §8.3）：能看永远可用，能改只在沙箱边界内。
// 判定顺序：sandboxPolicy → 会话 → 模式 → 仓库根是否在工作区内 → confine 探针。
// 任何一环缺失或不成立都 fail closed（返回只读），绝不静默放宽。

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

import type { WritePolicyReasonCode, WritePolicyValue } from '../shared/protocol.ts'
import type { GitConfiner } from './git-executor.ts'
import { GitCommandFailure } from './git-executor.ts'
import type { SessionsLike } from './repo-resolver.ts'

/** Structural subset of `ctx.sandboxPolicy` needed by the gate. */
export interface SandboxPolicySource {
  readonly workspaceRoot: string
  resolve(request?: { session?: Session | undefined }): SandboxExecutionPolicy
}

/** Structural subset of `ctx.sandbox` needed by the gate (the confine probe only). */
export interface SandboxLike {
  confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<{ argv: readonly string[]; enforcement: 'full' | 'partial' }>
}

/** Lazy service sources; absent services fail closed instead of disabling the plugin. */
export interface SandboxGateDeps {
  sessions?: (() => SessionsLike | undefined) | undefined
  sandboxPolicy?: (() => SandboxPolicySource | undefined) | undefined
  sandbox?: (() => SandboxLike | undefined) | undefined
}

/** The decision input: a resolved repository root and the requesting session. */
export interface WritePolicyInput {
  repoRoot: string
  sessionId: string
}

/** Cancellation for the confine probe. */
export interface EvaluateWritePolicyOptions {
  signal?: AbortSignal | undefined
}

/** Reason strings shown in the read-only banner; all failures say "fail closed". */
const REASONS = {
  policyUnavailable: '沙箱策略服务不可用，写操作已禁用（fail closed）',
  sessionNotLive: '会话不在运行中，无法确认沙箱边界，写操作已禁用（fail closed）',
  resolveFailed: '沙箱策略解析失败，写操作已禁用（fail closed）',
  readOnlyMode: '会话沙箱为只读模式，写操作已禁用',
  repoOutsideWorkspace: '仓库根不在沙箱工作区内，提交需要整个仓库目录在工作区内（fail closed）',
  sandboxUnavailable: '沙箱执行器不可用，写操作已禁用（fail closed）',
  confineFailed: '沙箱 confine 失败，写操作已禁用（fail closed）',
  partialEnforcement: '沙箱只能提供部分强制力，写操作已禁用（fail closed）',
} as const

/**
 * Decide whether write operations are allowed for one resolved repository.
 * Never throws: every uncertainty resolves to `{ mode: 'read-only', reason }`.
 * @param input - resolved repo root plus the session that owns the request.
 * @param deps - lazy sandbox services.
 * @param options - cancellation for the confine probe.
 */
export async function evaluateWritePolicy(
  input: WritePolicyInput,
  deps: SandboxGateDeps,
  options: EvaluateWritePolicyOptions = {},
): Promise<WritePolicyValue> {
  return (await resolveWriteAccess(input, deps, options)).policy
}

/** The gate decision plus, when writable, how each write command must be confined. */
export interface WriteAccess {
  policy: WritePolicyValue
  /** Present exactly when `policy.mode === 'read-write'`. */
  confiner?: GitConfiner | undefined
}

/**
 * Evaluate the gate for one write request (A2: every write re-evaluates, never reusing
 * the bootstrap answer) and return the confiner the write commands must run under.
 * `danger-full-access` runs unconfined; `workspace-write` wraps every argv in
 * `sandbox.confine` and fails closed if a later wrap reports partial enforcement.
 */
export async function resolveWriteAccess(
  input: WritePolicyInput,
  deps: SandboxGateDeps,
  options: EvaluateWritePolicyOptions = {},
): Promise<WriteAccess> {
  const session = deps.sessions?.()?.get(input.sessionId as SessionId)
  if (session === undefined) {
    return { policy: readOnly('sessionNotLive') }
  }

  const policySource = deps.sandboxPolicy?.()
  if (policySource === undefined) {
    return { policy: readOnly('policyUnavailable') }
  }

  let policy: SandboxExecutionPolicy
  try {
    policy = policySource.resolve({ session })
  } catch {
    return { policy: readOnly('resolveFailed', policySource.workspaceRoot) }
  }

  if (policy.mode === 'danger-full-access') {
    return { policy: { mode: 'read-write', workspaceRoot: policy.workspaceRoot }, confiner: { kind: 'unconfined' } }
  }
  if (policy.mode === 'read-only') {
    return { policy: readOnly('readOnlyMode', policy.workspaceRoot) }
  }

  // workspace-write: the whole repository (including .git) must sit inside the boundary.
  try {
    if (!(await isInside(policy.workspaceRoot, input.repoRoot))) {
      return { policy: readOnly('repoOutsideWorkspace', policy.workspaceRoot) }
    }
  } catch {
    return { policy: readOnly('repoOutsideWorkspace', policy.workspaceRoot) }
  }

  const sandbox = deps.sandbox?.()
  if (sandbox === undefined) {
    return { policy: readOnly('sandboxUnavailable', policy.workspaceRoot) }
  }

  const confinedPolicy: SandboxPolicy = { ...policy, mode: policy.mode }
  let enforcement: 'full' | 'partial'
  try {
    const confined = await sandbox.confine(['git', '--version'], confinedPolicy, options.signal)
    enforcement = confined.enforcement
  } catch {
    return { policy: readOnly('confineFailed', policy.workspaceRoot) }
  }
  if (enforcement !== 'full') {
    return { policy: readOnly('partialEnforcement', policy.workspaceRoot) }
  }

  const confiner: GitConfiner = {
    kind: 'confined',
    wrap: async (argv, signal) => {
      const confined = await sandbox.confine(argv, confinedPolicy, signal)
      // The probe said `full`; a backend that degrades later must not run the write.
      if (confined.enforcement !== 'full') throw new Error(REASONS.partialEnforcement)
      return confined.argv
    },
  }
  return { policy: { mode: 'read-write', workspaceRoot: policy.workspaceRoot }, confiner }
}

/**
 * Guard for write endpoints (v1.5): throws the structured code clients expect.
 * Read endpoints never call this, so a read-only boundary keeps reads available.
 */
export function assertWritable(policy: WritePolicyValue): void {
  if (policy.mode === 'read-write') return
  throw new GitCommandFailure(
    'git/sandbox-denied',
    policy.reason ?? '写操作被沙箱边界拒绝（fail closed）',
    { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
  )
}

const REASON_CODES: Record<keyof typeof REASONS, WritePolicyReasonCode> = {
  policyUnavailable: 'policy-unavailable',
  sessionNotLive: 'session-not-live',
  resolveFailed: 'resolve-failed',
  readOnlyMode: 'read-only-mode',
  repoOutsideWorkspace: 'repo-outside-workspace',
  sandboxUnavailable: 'sandbox-unavailable',
  confineFailed: 'confine-failed',
  partialEnforcement: 'partial-enforcement',
}

function readOnly(key: keyof typeof REASONS, workspaceRoot?: string | undefined): WritePolicyValue {
  const base: WritePolicyValue = { mode: 'read-only', reason: REASONS[key], reasonCode: REASON_CODES[key] }
  return workspaceRoot === undefined ? base : { ...base, workspaceRoot }
}

/** True when `target` is `root` itself or lives below it, after symlink resolution. */
async function isInside(root: string, target: string): Promise<boolean> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalize(root),
    canonicalize(target),
  ])
  const path = relative(canonicalRoot, canonicalTarget)
  if (path === '') return true
  return !path.startsWith('..') && !isAbsolute(path)
}

/** realpath when the path exists, absolute resolve otherwise (dormant directories). */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}
