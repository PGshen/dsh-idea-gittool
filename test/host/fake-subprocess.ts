// `ctx.subprocess` 的测试替身：用 node:child_process 真跑命令，
// 按 SubprocessRuntime 的公开契约实现 collect 模式的句柄（含 tail 截断与 lossy 语义）。
// 目的是让 src/host 的 git 代码在测试里被真实 git 驱动，同时不引入新的 devDependency。

import { spawn as spawnChild } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'

import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** One recorded spawn request: assertions read the exact spec the Host produced. */
export interface RecordedSpawn {
  readonly spec: SubprocessSpawnSpec
  /** Everything the caller wrote to a `'pipe'` stdin (or the batch `{ data }`), decoded as UTF-8. */
  stdinWritten?: string
}

/** Minimal `ctx.subprocess` surface consumed by the git executor. */
export interface FakeSubprocess {
  readonly spawns: readonly RecordedSpawn[]
  /** Executable returned by `resolveExecutable` (defaults to the real `git`). */
  executable: string
  resolveExecutable: (
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Promise<string>
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/**
 * `withholdStdin`: simulate a seam that spawns but hands back no `stdin` writable even though
 * `'pipe'` was requested (the child's fd 0 is an open pipe nobody can write to).
 */
export function createFakeSubprocess(options: { executable?: string; withholdStdin?: boolean } = {}): FakeSubprocess {
  const spawns: RecordedSpawn[] = []
  const fake: FakeSubprocess = {
    spawns,
    executable: options.executable ?? 'git',
    async resolveExecutable(_command, _env, signal) {
      signal?.throwIfAborted()
      return fake.executable
    },
    spawn: (spec) => {
      const recorded: RecordedSpawn = { spec }
      spawns.push(recorded)
      const handle = spawnCollected(spec, recorded)
      if (options.withholdStdin !== true || handle.stdin === undefined) return handle
      // The pipe stays open but unreachable: git blocks on fd 0 until it is terminated.
      return { ...handle, stdin: undefined }
    },
  }
  return fake
}

/** The most recent spawn spec, or a clear failure when nothing was spawned. */
export function lastSpawn(fake: FakeSubprocess): SubprocessSpawnSpec {
  const recorded = fake.spawns.at(-1)
  if (recorded === undefined) throw new Error('fake subprocess: no spawn recorded')
  return recorded.spec
}

/** Child environment exactly as the seam documents: ambient base, then explicit tombstones. */
function childEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  if (env === undefined) return base
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete base[key]
    else base[key] = value
  }
  return base
}

interface Collector {
  readonly reader: SubprocessOutputReader
}

/** Tail-retaining buffer that honors `maxBytes` and reports lossy reads by byte offset. */
function createCollector(stream: Readable, mode: SubprocessOutputMode): Collector | undefined {
  if (typeof mode === 'string') {
    if (mode === 'inherit') return undefined
    throw new Error('fake subprocess: raw pipe mode is not supported')
  }
  const maxBytes = Math.max(0, mode.maxBytes)
  const chunks: Buffer[] = []
  let total = 0
  let dropped = 0

  const trim = (): void => {
    while (total - dropped > maxBytes) {
      const head = chunks[0]
      if (head === undefined) return
      const excess = total - dropped - maxBytes
      if (head.length <= excess) {
        chunks.shift()
        dropped += head.length
      } else {
        chunks[0] = head.subarray(excess)
        dropped += excess
      }
    }
  }

  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    total += chunk.length
    trim()
  })

  const reader: SubprocessOutputReader = {
    readFrom(fromByte) {
      const retained = Buffer.concat(chunks)
      if (fromByte < dropped) {
        return { text: retained.toString('utf8'), nextOffset: total, lossy: true }
      }
      const relative = Math.min(Math.max(0, fromByte - dropped), retained.length)
      return {
        text: retained.subarray(relative).toString('utf8'),
        nextOffset: total,
        lossy: false,
      }
    },
  }
  return { reader }
}

/** Spawn with collect-mode stdio, matching the seam's handle contract. */
function spawnCollected(spec: SubprocessSpawnSpec, recorded: RecordedSpawn): SubprocessHandle {
  if (spec.signal?.aborted === true) {
    throw new Error('fake subprocess: spawn aborted before start')
  }
  const [program, ...args] = spec.argv
  if (program === undefined) {
    throw new Error('fake subprocess: argv must not be empty')
  }
  if (!(spec.graceMs > 0)) {
    throw new Error('fake subprocess: graceMs must be positive')
  }

  const child = spawnChild(program, args, {
    cwd: spec.cwd,
    env: childEnvironment(spec.env),
    stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  // stdin: 'pipe' hands the caller a tap that records what it writes and forwards it to the child.
  let stdinTap: PassThrough | undefined
  if (child.stdin !== null) {
    child.stdin.on('error', () => undefined)
    const written: Buffer[] = []
    const remember = (chunk: Buffer): void => {
      written.push(chunk)
      recorded.stdinWritten = Buffer.concat(written).toString('utf8')
    }
    const mode = spec.stdio.stdin
    if (mode === 'pipe') {
      stdinTap = new PassThrough()
      stdinTap.on('data', remember)
      stdinTap.pipe(child.stdin)
    } else if (typeof mode === 'object') {
      remember(Buffer.from(mode.data, 'utf8'))
      child.stdin.end(mode.data)
    }
  }
  if (child.stdout === null || child.stderr === null) throw new Error('fake subprocess: output pipes missing')
  const stdout = createCollector(child.stdout, spec.stdio.stdout)
  const stderr = createCollector(child.stderr, spec.stdio.stderr)
  const collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader } = {}
  if (stdout !== undefined) collected.stdout = stdout.reader
  if (stderr !== undefined) collected.stderr = stderr.reader

  let settled = false
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('error', (error) => {
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => {
      settled = true
      resolve({ exitCode: code, signal })
    })
  })

  const onAbort = (): void => {
    child.kill('SIGKILL')
  }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    stdin: stdinTap,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected,
    done,
    terminate: () => {
      child.kill('SIGKILL')
    },
    waitForExit: async (waitSignal) => {
      if (settled) return true
      return await new Promise<boolean>((resolve) => {
        const finish = (): void => {
          resolve(true)
        }
        done.then(finish, finish)
        waitSignal?.addEventListener('abort', () => resolve(false), { once: true })
      })
    },
  }
}
