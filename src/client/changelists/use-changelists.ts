// React glue for changelists (plan b3c T5): load per repository, follow the current changes, save on
// every change. Storage access is guarded inside the model.
import { useCallback, useEffect, useState } from 'react'
import { loadChangelists, saveChangelists, syncPaths } from './changelist-model.ts'
import type { ChangelistState } from './changelist-model.ts'

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

export function useChangelists(repoRoot: string | null, changedPaths: readonly string[]): {
  state: ChangelistState
  update: (change: (state: ChangelistState) => ChangelistState) => void
} {
  const [state, setState] = useState<ChangelistState>(() => loadChangelists(browserStorage(), repoRoot ?? ''))
  useEffect(() => { setState(loadChangelists(browserStorage(), repoRoot ?? '')) }, [repoRoot])
  const key = changedPaths.join('\0')
  useEffect(() => {
    setState((current) => {
      const next = syncPaths(current, key === '' ? [] : key.split('\0'))
      if (next !== current && repoRoot !== null) saveChangelists(browserStorage(), repoRoot, next)
      return next
    })
  }, [key, repoRoot])
  const update = useCallback((change: (current: ChangelistState) => ChangelistState) => {
    setState((current) => {
      const next = change(current)
      if (next !== current && repoRoot !== null) saveChangelists(browserStorage(), repoRoot, next)
      return next
    })
  }, [repoRoot])
  return { state, update }
}
