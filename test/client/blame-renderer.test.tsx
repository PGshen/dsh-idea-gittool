// B4a T5 optional "Git Blame" document renderer: definition, setting-driven registration, body states.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CODE_HIGHLIGHT_EXTENSIONS } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  BLAME_RENDERER_ID,
  RENDERED_BY_DSH,
  BlameRendererFallback,
  bindBlameRenderer,
  blameRendererDefinition,
  blameRendererState,
} from '../../src/client/blame-renderer.tsx'
import { withLocale } from './i18n-helpers.tsx'

describe('blameRendererDefinition', () => {
  it('claims the code extensions in the extension band with text pages', () => {
    const definition = blameRendererDefinition(() => 'Git Blame')
    expect(definition.id).toBe(BLAME_RENDERER_ID)
    expect(BLAME_RENDERER_ID).toBe('dsh-idea-gittool/blame')
    expect(definition.extensions).toEqual(CODE_HIGHLIGHT_EXTENSIONS.filter(extension => !RENDERED_BY_DSH.includes(extension)))
    expect(definition.extensions).toContain('ts')
    expect(definition.priority).toBe('extension')
    expect(definition.loading).toBe('text-pages')
    expect(definition.title()).toBe('Git Blame')
  })

  it('leaves suffixes with their own DSH viewer alone (review I1: Markdown, HTML, CSV, images)', () => {
    const { extensions } = blameRendererDefinition(() => 'Git Blame')
    for (const suffix of ['md', 'markdown', 'html', 'htm', 'csv', 'tsv', 'svg', 'png', 'pdf', 'xlsx']) {
      expect(extensions, suffix).not.toContain(suffix)
    }
  })
})

describe('bindBlameRenderer', () => {
  function fakeSetting(initial: boolean) {
    let value = initial
    const listeners = new Set<(on: boolean) => void>()
    return {
      read: () => value,
      subscribe: (listener: (on: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: boolean) => { value = next; for (const listener of [...listeners]) listener(next) },
      listeners,
    }
  }

  function fakeRegistry() {
    const disposers: ReturnType<typeof vi.fn>[] = []
    const register = vi.fn(() => {
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    })
    return { register, disposers }
  }

  const definition = blameRendererDefinition(() => 'Git Blame')

  it('does not register while the setting is off', () => {
    const registry = fakeRegistry()
    bindBlameRenderer(registry, definition, fakeSetting(false))
    expect(registry.register).not.toHaveBeenCalled()
  })

  it('registers on, unregisters off, registers again, and never twice for repeated notifications', () => {
    const registry = fakeRegistry()
    const setting = fakeSetting(false)
    bindBlameRenderer(registry, definition, setting)
    setting.set(true)
    setting.set(true)
    expect(registry.register).toHaveBeenCalledTimes(1)
    expect(registry.register).toHaveBeenCalledWith(definition)
    setting.set(false)
    expect(registry.disposers[0]).toHaveBeenCalledTimes(1)
    setting.set(true)
    expect(registry.register).toHaveBeenCalledTimes(2)
  })

  it('registers right away when already on; cleanup unregisters and stops listening', () => {
    const registry = fakeRegistry()
    const setting = fakeSetting(true)
    const cleanup = bindBlameRenderer(registry, definition, setting)
    expect(registry.register).toHaveBeenCalledTimes(1)
    cleanup()
    expect(registry.disposers[0]).toHaveBeenCalledTimes(1)
    expect(setting.listeners.size).toBe(0)
    setting.set(true)
    expect(registry.register).toHaveBeenCalledTimes(1)
  })

  it('a registry that throws (duplicate id) does not break the plugin', () => {
    const setting = fakeSetting(true)
    expect(() => bindBlameRenderer({ register: () => { throw new Error('duplicate') } }, definition, setting)).not.toThrow()
  })
})

describe('blameRendererState', () => {
  const base = { absolutePath: '/repo/src/a.ts', repoRoot: '/repo', bootstrapLoaded: true, untrackedPaths: [] as string[] }

  it('blames a tracked file inside the repository', () => {
    expect(blameRendererState(base)).toEqual({ kind: 'blame', path: 'src/a.ts' })
  })

  it('waits for the path and the repository snapshot', () => {
    expect(blameRendererState({ ...base, absolutePath: undefined })).toEqual({ kind: 'loading' })
    expect(blameRendererState({ ...base, bootstrapLoaded: false, repoRoot: null })).toEqual({ kind: 'loading' })
  })

  it('falls back for files outside a repository or not tracked yet', () => {
    expect(blameRendererState({ ...base, repoRoot: null })).toEqual({ kind: 'outside' })
    expect(blameRendererState({ ...base, absolutePath: '/elsewhere/a.ts' })).toEqual({ kind: 'outside' })
    expect(blameRendererState({ ...base, untrackedPaths: ['src/a.ts'] })).toEqual({ kind: 'untracked' })
  })
})

describe('BlameRendererFallback', () => {
  it('shows the reason and the file text', () => {
    const html = renderToStaticMarkup(withLocale(<BlameRendererFallback reason="untracked" text={'const a = 1\n<b>'} wrap={false} />))
    expect(html).toContain('还没有被 Git 跟踪')
    expect(html).toContain('const a = 1')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('role="status"')
    expect(renderToStaticMarkup(withLocale(<BlameRendererFallback reason="outside" text="" wrap />))).toContain('不在 Git 仓库中')
  })
})
