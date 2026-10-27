// B1 T6 host fullscreen for the merge window (design §5.3, AC10, controller ruling 5).
// "Already fullscreen" comes from the public `useTabInfo().sidebar.fullscreen` (it includes the
// auto fullscreen below 768px, references §14). The window enters fullscreen only when the panel is
// neither, and on close leaves it only when the window itself entered it and the panel is still
// fullscreen (the user may have left it with the panel button). Toggling while auto-fullscreen would
// collapse the panel, so that case never toggles.
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Below this viewport width the sidebar is always fullscreen (`SidebarRight.tsx`, same threshold). */
export const AUTO_FULLSCREEN_MAX_WIDTH = 768

export function isAutoFullscreenViewport(width: number): boolean {
  return width < AUTO_FULLSCREEN_MAX_WIDTH
}

export function decideFullscreen(input: { autoFullscreen: boolean; alreadyFullscreen: boolean }): 'enter' | 'none' {
  return !input.autoFullscreen && !input.alreadyFullscreen ? 'enter' : 'none'
}

export function decideFullscreenExit(input: { enteredByUs: boolean; fullscreen: boolean; autoFullscreen: boolean }): 'exit' | 'none' {
  return input.enteredByUs && input.fullscreen && !input.autoFullscreen ? 'exit' : 'none'
}

/** What the workbench gets from the slot: the tab's fullscreen flag and the panel toggle. */
export interface SidebarFullscreen {
  /** `useTabInfo().sidebar.fullscreen`. */
  fullscreen: boolean
  /** Toggles the panel that contains `element` (`sidebarRight.commandTarget` + `toggleFullscreen`). */
  toggle: (element: Element | null) => void
}

function viewportWidth(): number {
  const width = (globalThis as { innerWidth?: number }).innerWidth
  return typeof width === 'number' ? width : Number.POSITIVE_INFINITY
}

/**
 * Enter host fullscreen while the merge window is mounted (once per mount) and leave it on unmount
 * when the window entered it. Without a sidebar (tests, other hosts) nothing happens.
 */
export function useMergeFullscreen(rootRef: RefObject<HTMLElement | null>, sidebar: SidebarFullscreen | undefined): void {
  const latest = useRef(sidebar)
  latest.current = sidebar
  // Layout effect: its cleanup runs while the window is still attached, so the toggle finds its pane.
  useLayoutEffect(() => {
    const host = latest.current
    if (host === undefined) return undefined
    const element = rootRef.current
    let enteredByUs = false
    if (decideFullscreen({ autoFullscreen: isAutoFullscreenViewport(viewportWidth()), alreadyFullscreen: host.fullscreen }) === 'enter') {
      host.toggle(element)
      enteredByUs = true
    }
    return () => {
      const now = latest.current
      if (now === undefined) return
      const exit = decideFullscreenExit({ enteredByUs, fullscreen: now.fullscreen, autoFullscreen: isAutoFullscreenViewport(viewportWidth()) })
      if (exit === 'exit') now.toggle(element)
    }
  }, [rootRef])
}
