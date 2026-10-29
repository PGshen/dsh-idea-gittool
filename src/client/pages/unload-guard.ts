// T2 (B1 final review): while the merge window holds unsaved changes, reloading or closing the page
// asks the browser's own "leave site?" question instead of silently dropping them.
import { useEffect } from 'react'

function onBeforeUnload(event: Event): void {
  event.preventDefault()
  // Older browsers only ask when returnValue is set (BeforeUnloadEvent's legacy string field).
  Reflect.set(event, 'returnValue', '')
}

/** Registers the `beforeunload` guard on `target`; returns its removal. */
export function installUnloadGuard(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  target.addEventListener('beforeunload', onBeforeUnload)
  return () => { target.removeEventListener('beforeunload', onBeforeUnload) }
}

/** Keeps the guard registered exactly while `active` (removed when it turns false or on unmount). */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return undefined
    return installUnloadGuard(window)
  }, [active])
}
