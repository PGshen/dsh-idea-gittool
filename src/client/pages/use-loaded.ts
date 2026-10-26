// Load-once hook for forms that need a read endpoint first (remotes, reset preview).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitError, RpcResult } from '../../shared/protocol.ts'

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: GitError }

export interface Loaded<T> {
  state: LoadState<T>
  reload: () => void
}

/** Runs `load` on mount and on {@link Loaded.reload}; a superseded or unmounted load is ignored. */
export function useLoaded<T>(load: () => Promise<RpcResult<T>>): Loaded<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })
  const [round, setRound] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    loadRef.current()
      .then((result) => {
        if (!current) return
        setState(result.ok ? { status: 'ready', value: result.value } : { status: 'error', error: result.error })
      })
      .catch((error: unknown) => {
        if (current) setState({ status: 'error', error: { code: 'git/exec-failed', message: error instanceof Error ? error.message : String(error) } })
      })
    return () => { current = false }
  }, [round])
  const reload = useCallback(() => { setRound(value => value + 1) }, [])
  return { state, reload }
}
