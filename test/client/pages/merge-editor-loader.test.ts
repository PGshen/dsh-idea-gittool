// B4c T3: CodeMirror ships as the on-demand chunk lib/client.merge.js; the merge window loads it lazily.
import { afterEach, describe, expect, it } from 'vitest'

import {
  loadMergeEditor,
  loadedMergeEditor,
  setMergeEditorImporterForTest,
} from '../../../src/client/pages/merge-editor-loader.ts'
import type { MergeEditor } from '../../../src/client/pages/merge-editor-loader.ts'
import { resultEditable } from '../../../src/client/pages/merge-pane-state.ts'

afterEach(() => { setMergeEditorImporterForTest(null) })

describe('loadMergeEditor', () => {
  it('loads the CodeMirror module once and then serves it synchronously', async () => {
    setMergeEditorImporterForTest(null)
    expect(loadedMergeEditor()).toBeUndefined()

    const [first, second] = await Promise.all([loadMergeEditor(), loadMergeEditor()])

    expect(first).toBe(second)
    expect(typeof first.createMergePane).toBe('function')
    expect(loadedMergeEditor()).toBe(first)
  })

  it('shares one in-flight import between concurrent callers', async () => {
    let calls = 0
    const module = { createMergePane: () => undefined } as unknown as MergeEditor
    setMergeEditorImporterForTest(async () => {
      calls += 1
      return module
    })

    await Promise.all([loadMergeEditor(), loadMergeEditor(), loadMergeEditor()])

    expect(calls).toBe(1)
  })

  it('forgets a failed import so the next open can retry', async () => {
    let calls = 0
    const module = { createMergePane: () => undefined } as unknown as MergeEditor
    setMergeEditorImporterForTest(async () => {
      calls += 1
      if (calls === 1) throw new Error('chunk 404')
      return module
    })

    await expect(loadMergeEditor()).rejects.toThrow('chunk 404')
    expect(loadedMergeEditor()).toBeUndefined()
    await expect(loadMergeEditor()).resolves.toBe(module)
    expect(calls).toBe(2)
  })
})

describe('resultEditable (CodeMirror-free, used while rendering)', () => {
  it('is editable only once the file is ready', () => {
    expect(resultEditable('ready')).toBe(true)
    expect(resultEditable('loading')).toBe(false)
  })
})
