/**
 * Registration wiring for the document-header actions and the `git.blame` page.
 * A minimal fake context records the calls; no real slot runtime is involved.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { zhT } from './i18n-helpers.tsx'
import { render } from '../../src/client/localized-text.ts'

import { DocumentActions } from '../../src/client/document-actions.tsx'
import { BlamePage } from '../../src/client/blame-page.tsx'
import {
  BLAME_KIND,
  BLAME_TAB_ID,
  DOCUMENT_ACTIONS_ID,
  hasDocumentActionsSlot,
  openBlameTab,
  registerBlameTab,
  registerDocumentActions,
} from '../../src/client/register-document-actions.ts'
import type { DocumentActionsInjected } from '../../src/client/document-actions.tsx'

interface FakeRegistration {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface FakeContext {
  readonly ctx: ClientContext
  readonly registrations: FakeRegistration[]
  readonly injectedSlots: string[]
  readonly tabDefinitions: Array<Record<string, unknown>>
  readonly openedTabs: Array<{ kind: string; options: Record<string, unknown> | undefined }>
  readonly effectCount: () => number
}

function createFakeContext(options: {
  declareActionsSlot?: boolean
  openThrows?: boolean
} = {}): FakeContext {
  const registrations: FakeRegistration[] = []
  const injectedSlots: string[] = []
  const tabDefinitions: Array<Record<string, unknown>> = []
  const openedTabs: Array<{ kind: string; options: Record<string, unknown> | undefined }> = []
  let effects = 0
  const asDisposer = (value: unknown): (() => void) => (typeof value === 'function' ? value as () => void : () => {})
  const ctx = {
    effect: (callback: () => unknown) => {
      effects += 1
      return asDisposer(callback())
    },
    slots: {
      inject: (key: string, callback: () => unknown) => {
        injectedSlots.push(key)
        return asDisposer(callback())
      },
      register: (registrationOptions: Record<string, unknown>, component: unknown) => {
        registrations.push({
          name: String(registrationOptions.name),
          options: registrationOptions,
          component,
        })
        return () => {}
      },
      spec: () => (options.declareActionsSlot === true ? {} as never : undefined),
    },
    sidebarRightTabs: {
      register: (definition: Record<string, unknown>) => {
        tabDefinitions.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab: (kind: string, openOptions?: Record<string, unknown>) => {
        if (options.openThrows === true) throw new Error('sidebar-right: no on-screen session')
        openedTabs.push({ kind, options: openOptions })
      },
    },
  }
  return {
    ctx: ctx as unknown as ClientContext,
    registrations,
    injectedSlots,
    tabDefinitions,
    openedTabs,
    effectCount: () => effects,
  }
}

function injectedFace(fake: FakeContext, sessionId = 'session-1'): DocumentActionsInjected {
  const registration = fake.registrations[0]
  if (registration === undefined) throw new Error('no registration was recorded')
  const inject = registration.options.inject as ((id: string) => DocumentActionsInjected) | undefined
  if (inject === undefined) throw new Error('registration carries no inject factory')
  return inject(sessionId)
}

describe('registerBlameTab', () => {
  it('registers the page type and its body under one id', () => {
    const fake = createFakeContext()
    registerBlameTab(fake.ctx)

    expect(fake.tabDefinitions).toHaveLength(1)
    const definition = fake.tabDefinitions[0]!
    expect(definition.id).toBe(BLAME_TAB_ID)
    expect(definition.kind).toBe(BLAME_KIND)
    expect(definition.priority).toBe('extension')
    expect((definition.title as () => string)()).toBe('Blame')

    expect(fake.injectedSlots).toEqual(['sidebar.right.pane.tab'])
    expect(fake.registrations).toHaveLength(1)
    const body = fake.registrations[0]!
    expect(body.name).toBe('sidebar.right.pane.tab')
    expect(body.options.key).toBe(BLAME_TAB_ID)
    expect(body.component).toBe(BlamePage)
  })

  it('wraps every registration in an effect so unload reclaims it', () => {
    const fake = createFakeContext()
    registerBlameTab(fake.ctx)
    expect(fake.effectCount()).toBe(2)
  })
})

describe('registerDocumentActions', () => {
  it('registers the component into the document header seat', () => {
    const fake = createFakeContext()
    registerDocumentActions(fake.ctx)

    expect(fake.injectedSlots).toEqual(['sidebar.right.tab.document.actions'])
    expect(fake.registrations).toHaveLength(1)
    const registration = fake.registrations[0]!
    expect(registration.name).toBe('sidebar.right.tab.document.actions')
    expect(registration.options.id).toBe(DOCUMENT_ACTIONS_ID)
    expect(registration.component).toBe(DocumentActions)
    expect(fake.effectCount()).toBe(1)
  })

  it('opens the blame page with the absolute path from the document', () => {
    const fake = createFakeContext()
    registerDocumentActions(fake.ctx)

    const face = injectedFace(fake)
    expect(face.statusFor?.('/repo/src/a.ts')).toBeNull()
    expect(face.repoRootFor?.('/repo/src/a.ts')).toBeNull()
    expect(face.openBlame?.('/repo/src/a.ts')).toBeNull()
    expect(fake.openedTabs).toEqual([
      { kind: BLAME_KIND, options: { params: { absolutePath: '/repo/src/a.ts' } } },
    ])
    expect(face.openBlame?.('/repo/src/a.ts', 'src/a.ts')).toBeNull()
    expect(fake.openedTabs[1]).toEqual({
      kind: BLAME_KIND,
      options: { params: { absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' } },
    })
  })

  it('forwards the optional status and repository-root lookups', () => {
    const fake = createFakeContext()
    registerDocumentActions(fake.ctx, {
      statusCodeFor: absolutePath => (absolutePath.endsWith('.ts') ? ' M' : null),
      repoRootFor: () => '/repo',
    })

    const face = injectedFace(fake, 'session-2')
    expect(face.statusFor?.('/repo/src/a.ts')).toBe('M')
    expect(face.repoRootFor?.('/repo/src/a.ts')).toBe('/repo')
  })

  it('reports why the blame page could not open instead of throwing', () => {
    const fake = createFakeContext({ openThrows: true })
    registerDocumentActions(fake.ctx)

    const message = injectedFace(fake).openBlame?.('/repo/src/a.ts') ?? null
    expect(message === null ? null : render(zhT, message)).toContain('会话')
  })
})

describe('degradation helpers', () => {
  it('detects whether the running Sidebar declares the document-actions seat', () => {
    expect(hasDocumentActionsSlot(createFakeContext().ctx)).toBe(false)
    expect(hasDocumentActionsSlot(createFakeContext({ declareActionsSlot: true }).ctx)).toBe(true)
  })

  it('opens the blame page directly for hosts without the seat', () => {
    const fake = createFakeContext()
    expect(openBlameTab(fake.ctx, '/repo/src/a.ts')).toBe(true)
    expect(fake.openedTabs[0]).toEqual({
      kind: BLAME_KIND,
      options: { params: { absolutePath: '/repo/src/a.ts' } },
    })
    expect(openBlameTab(fake.ctx)).toBe(true)
    expect(fake.openedTabs[1]).toEqual({ kind: BLAME_KIND, options: {} })
    expect(openBlameTab(fake.ctx, '/repo/src/a.ts', 'src/a.ts')).toBe(true)
    expect(fake.openedTabs[2]).toEqual({
      kind: BLAME_KIND,
      options: { params: { absolutePath: '/repo/src/a.ts', repoRelativePath: 'src/a.ts' } },
    })
  })

  it('returns false when no session can host the page', () => {
    expect(openBlameTab(createFakeContext({ openThrows: true }).ctx, '/repo/a.ts')).toBe(false)
  })
})
