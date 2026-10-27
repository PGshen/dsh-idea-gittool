// B3c T5: the commit page grouped by changelist (static rendering).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { addList, changelistSections, emptyChangelists, moveTo, setActive } from '../../../src/client/changelists/changelist-model.ts'
import { ChangelistView } from '../../../src/client/pages/ChangelistView.tsx'
import type { ChangeEntry } from '../../../src/client/store/changes-store.ts'
import { withLocale, zhT } from '../i18n-helpers.tsx'

const noop = (): void => {}
const change = (path: string, group: ChangeEntry['group'] = 'modified'): ChangeEntry =>
  ({ path, status: group === 'conflicts' ? 'U' : 'M', group, staged: false, unstaged: true, diffScope: 'worktree' }) as ChangeEntry

function render(extra: Partial<Parameters<typeof ChangelistView>[0]> = {}): string {
  const { state, id } = addList(emptyChangelists(), '调试')
  const lists = setActive(moveTo(state, ['b.txt'], id), id)
  const entries = [change('a.txt'), change('b.txt'), change('c.txt', 'conflicts')]
  return renderToStaticMarkup(withLocale(
    <ChangelistView
      t={zhT}
      sections={changelistSections(entries, lists, new Set(['b.txt']))}
      checked={new Set(['b.txt'])}
      collapsed={new Set()}
      editing={null}
      menu={null}
      writeDisabled={false}
      onToggleCollapsed={noop} onToggleFile={noop} onSetChecked={noop} onOpenDiff={noop} onMove={noop}
      onSetActive={noop} onEdit={noop} onCommitEdit={noop} onRemove={noop} onRowMenu={noop}
      {...extra}
    />,
  ))
}

describe('ChangelistView', () => {
  it('shows one section per list with counts, the active badge and draggable rows', () => {
    const html = render()
    expect(html).toContain('Changes')
    expect(html).toContain('调试')
    expect(html).toContain('活动')
    expect(html).toContain('draggable="true"')
    expect(html.match(/data-changelist="/g)?.length).toBe(2)
    expect(html).toMatch(/disabled=""[^>]*\/>.*c\.txt|aria-label="c\.txt"[^>]*disabled=""/u)
  })

  it('does not offer rename or delete for the default list, and shows the move menu', () => {
    const html = render({ menu: { path: 'a.txt', x: 10, y: 10 } })
    const defaultHeader = html.slice(html.indexOf('data-changelist="default"'), html.indexOf('data-changelist="cl-'))
    expect(defaultHeader).not.toContain('重命名')
    expect(html).toContain('移到 Changelist')
    expect(html.match(/data-move-to=/g)?.length).toBe(2)
  })

  it('edits a new list name inline', () => {
    expect(render({ editing: { id: null, value: '新' } })).toContain('data-changelist-edit')
    expect(render()).toContain('新建 Changelist…')
  })
})
