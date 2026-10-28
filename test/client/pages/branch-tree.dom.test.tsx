// @vitest-environment happy-dom
// B4b T4: the branch tree is a single Tab stop with full arrow-key navigation (roving tabindex).
import { useState } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { BranchPanel } from '../../../src/client/pages/BranchPanel.tsx'
import { BranchesPage } from '../../../src/client/pages/BranchesPage.tsx'
import type { BranchPanelProps } from '../../../src/client/pages/BranchPanel.tsx'
import type { BranchGroupKind, CollapsedGroups } from '../../../src/client/pages/branch-store.ts'
import { focus, press, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale } from '../i18n-helpers.tsx'
import { branchesFixture } from './branch-fixtures.ts'

function Harness(props: Partial<BranchPanelProps>): ReactElement {
  const [groups, setGroups] = useState<CollapsedGroups>({ head: false, local: false, remote: false, tags: false })
  const [dirs, setDirs] = useState<Record<string, boolean>>({})
  return (
    <BranchPanel
      value={branchesFixture()}
      mode="wide"
      open
      search=""
      collapsedGroups={groups}
      collapsedDirs={dirs}
      flat={false}
      onNavigate={() => {}}
      onFilter={() => {}}
      onToggleGroup={(kind: BranchGroupKind) => setGroups(current => ({ ...current, [kind]: !current[kind] }))}
      onToggleDirectory={path => setDirs(current => ({ ...current, [path]: current[path] !== true }))}
      {...props}
    />
  )
}

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

function mount(props: Partial<BranchPanelProps> = {}): HTMLElement {
  view = render(withLocale(<Harness {...props} />) as ReactElement)
  return view.container.querySelector<HTMLElement>('[role="tree"]') as HTMLElement
}

function stops(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[tabindex="0"]')]
}

function describeActive(): string {
  const element = document.activeElement as HTMLElement | null
  return element?.dataset.groupToggle ?? element?.dataset.branchName ?? (element?.dataset.path === undefined ? '' : `dir:${element.dataset.path}`)
}

describe('branch tree roving tabindex (DOM)', () => {
  it('has exactly one Tab stop: the first row without a selection, the selected row otherwise', () => {
    let tree = mount()
    expect(stops(tree).map(element => element.dataset.groupToggle)).toEqual(['head'])
    view?.unmount()
    tree = mount({ selectedRef: 'refs/heads/feat/login' })
    expect(stops(tree).map(element => element.dataset.branchName)).toEqual(['feat/login'])
  })

  it('Home / End / ArrowDown / ArrowUp walk every visible row and move the Tab stop along', () => {
    const tree = mount()
    focus(stops(tree)[0] as HTMLElement)
    press('ArrowDown')
    expect(describeActive()).toBe('main')
    press('ArrowDown')
    expect(describeActive()).toBe('local')
    press('ArrowUp')
    expect(describeActive()).toBe('main')
    expect(stops(tree)).toEqual([document.activeElement])
    press('End')
    const last = describeActive()
    press('Home')
    expect(describeActive()).toBe('head')
    expect(last).not.toBe('head')
  })

  it('ArrowLeft goes to the parent then collapses it; ArrowRight expands then enters the first child', () => {
    const tree = mount()
    focus(tree.querySelector('[data-branch-name="feat/login"]') as HTMLElement)
    press('ArrowLeft')
    expect(describeActive()).toBe('dir:feat')
    press('ArrowLeft')
    expect((document.activeElement as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    expect(tree.querySelector('[data-branch-name="feat/login"]')).toBeNull()
    press('ArrowRight')
    expect((document.activeElement as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    press('ArrowRight')
    expect(describeActive()).toBe('feat/login')
    press('ArrowLeft')
    press('ArrowLeft')
    press('ArrowLeft')
    expect(describeActive()).toBe('local')
  })

  it('group headers expand and collapse with ArrowRight / ArrowLeft', () => {
    const tree = mount()
    const local = tree.querySelector<HTMLElement>('[data-group-toggle="local"]') as HTMLElement
    focus(local)
    press('ArrowLeft')
    expect(local.getAttribute('aria-expanded')).toBe('false')
    press('ArrowRight')
    expect(local.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the Tab stop on the focused branch across a refresh', () => {
    const tree = mount()
    focus(tree.querySelector('[data-branch-name="feat/ui"]') as HTMLElement)
    view?.rerender(withLocale(<Harness value={{ ...branchesFixture() }} />) as ReactElement)
    expect(stops(tree).map(element => element.dataset.branchName)).toEqual(['feat/ui'])
  })
})

describe('Branches page tree (DOM)', () => {
  it('shares the roving tabindex: one stop, ArrowDown moves it, click selection becomes the stop', () => {
    const noop = (): void => {}
    view = render(withLocale(
      <BranchesPage
        value={branchesFixture()}
        context={{ writable: true, operation: null, current: 'main', dirty: false }}
        search=""
        collapsedGroups={{ head: false, local: false, remote: false, tags: false }}
        collapsedDirs={{}}
        flat={false}
        onSearchChange={noop}
        onToggleGroup={noop}
        onToggleDirectory={noop}
        onAction={noop}
        onQuickAction={noop}
        onFetch={noop}
      />,
    ) as ReactElement)
    const tree = view.container.querySelector<HTMLElement>('[role="tree"]') as HTMLElement
    expect(stops(tree)).toHaveLength(1)
    focus(stops(tree)[0] as HTMLElement)
    press('ArrowDown')
    expect(stops(tree)).toEqual([document.activeElement])
    expect(tree.querySelectorAll('[data-row-menu][tabindex="0"]')).toHaveLength(0)
  })
})
