// @vitest-environment happy-dom
// T2 (B1 final review): a dirty merge window registers a beforeunload guard; it is removed once the
// window is clean again or unmounted.
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUnloadGuard } from '../../../src/client/pages/unload-guard.ts'
import { render } from '../dom.tsx'

afterEach(() => { document.body.innerHTML = '' })

function Guarded(props: { dirty: boolean }): ReactNode {
  useUnloadGuard(props.dirty)
  return null
}

/** True when a page unload would be asked about. */
function unloadBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('useUnloadGuard', () => {
  it('guards only while dirty, and not after unmount', () => {
    const view = render(<Guarded dirty={false} />)
    expect(unloadBlocked()).toBe(false)
    view.rerender(<Guarded dirty />)
    expect(unloadBlocked()).toBe(true)
    view.rerender(<Guarded dirty={false} />)
    expect(unloadBlocked()).toBe(false)
    view.rerender(<Guarded dirty />)
    view.unmount()
    expect(unloadBlocked()).toBe(false)
  })
})
