// User-supplied regex search runs in a worker thread (评审 I2).
// A catastrophic pattern such as `^(a+)+$` would otherwise spin the Host's event loop and
// freeze every session; the git subprocess timeout does not cover JS matching. Each batch
// gets a deadline: on expiry the worker is terminated and the search fails as `git/timeout`.
// Literal search stays on the main thread (`String#includes` cannot backtrack).

import { Worker } from 'node:worker_threads'

import { GitCommandFailure } from '../git-executor.ts'

/** Deadline for matching one batch of records (one search chunk). */
export const REGEX_BATCH_TIMEOUT_MS = 2_000

/** The worker body: compile once, then answer `{ id, items }` with one boolean per item. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const pattern = new RegExp(workerData.source, workerData.flags)
parentPort.on('message', ({ id, items }) => {
  const results = items.map((texts) => texts.some((text) => pattern.test(text)))
  parentPort.postMessage({ id, results })
})
`

export interface RegexBatchMatcher {
  /** For each item, whether any of its texts matches. */
  match: (items: readonly (readonly string[])[]) => Promise<boolean[]>
  /** Terminate the worker; idempotent. */
  close: () => Promise<void>
}

/** Start a worker for one search; the caller closes it when the scan ends. */
export function createRegexBatchMatcher(
  source: string,
  flags: string,
  timeoutMs: number = REGEX_BATCH_TIMEOUT_MS,
): RegexBatchMatcher {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source, flags } })
  // The worker must never keep the Host process alive on its own.
  worker.unref()
  let nextId = 0
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await worker.terminate()
  }

  const match = (items: readonly (readonly string[])[]): Promise<boolean[]> => {
    if (closed) return Promise.reject(new GitCommandFailure('git/exec-failed', 'regex matcher is closed', {}))
    const id = nextId
    nextId += 1
    return new Promise<boolean[]>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        worker.off('message', onMessage)
        worker.off('error', onError)
      }
      const onMessage = (message: { id: number; results: boolean[] }): void => {
        if (message.id !== id) return
        cleanup()
        resolve(message.results)
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(new GitCommandFailure('git/exec-failed', `regex search failed: ${error.message}`, {}))
      }
      const timer = setTimeout(() => {
        cleanup()
        void close()
        reject(new GitCommandFailure('git/timeout', 'regular expression search timed out; simplify the pattern', {
          timeoutMs,
        }))
      }, timeoutMs)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.postMessage({ id, items })
    })
  }

  return { match, close }
}
