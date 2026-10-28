// @vitest-environment happy-dom
// B4b acceptance walkthrough: after a gutter » « × action the buttons are re-rendered and focus fell
// to <body> (F7 / Ctrl+Z dead). refocusAfterGutter puts it on the next chunk's button, else the Result.
import { afterEach, describe, expect, it } from 'vitest'
import { refocusAfterGutter } from '../../../src/client/pages/merge-window-controller.ts'

afterEach(() => { document.body.innerHTML = '' })

function pane(chunks: Array<[number, 'accept' | 'ignore']>): HTMLElement {
  const root = document.createElement('div')
  for (const [chunk, kind] of chunks) {
    const button = document.createElement('button')
    button.dataset.chunk = String(chunk)
    button.dataset.chunkAction = kind
    root.append(button)
  }
  document.body.append(root)
  return root
}

/** The pressed button was removed: focus is back on <body>. */
function dropFocus(): void {
  const probe = document.createElement('button')
  document.body.append(probe)
  probe.focus()
  probe.remove()
}

function result(): HTMLElement {
  const content = document.createElement('div')
  content.tabIndex = 0
  content.className = 'result'
  document.body.append(content)
  return content
}

describe('refocusAfterGutter', () => {
  it('focuses the same action on the next chunk of the pane', () => {
    const left = pane([[1, 'ignore'], [1, 'accept'], [4, 'ignore'], [4, 'accept']])
    const target = refocusAfterGutter(left, result(), { chunk: 0, kind: 'accept' })
    expect(target).toBe(left.querySelector('[data-chunk="1"][data-chunk-action="accept"]'))
    expect(document.activeElement).toBe(target)
  })

  it('wraps to the first remaining chunk, then falls back to the Result editor', () => {
    const left = pane([[1, 'accept']])
    expect(refocusAfterGutter(left, result(), { chunk: 3, kind: 'accept' })).toBe(left.querySelector('[data-chunk="1"]'))
    dropFocus()
    const empty = pane([])
    const editor = result()
    expect(refocusAfterGutter(empty, editor, { chunk: 3, kind: 'accept' })).toBe(editor)
    expect(document.activeElement).toBe(editor)
  })

  it('leaves focus alone when it is still somewhere (the user moved on)', () => {
    const left = pane([[1, 'accept']])
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    expect(refocusAfterGutter(left, result(), { chunk: 0, kind: 'accept' })).toBeNull()
    expect(document.activeElement).toBe(other)
  })
})
