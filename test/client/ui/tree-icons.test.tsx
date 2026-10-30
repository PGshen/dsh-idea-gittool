// Shared tree glyphs: vector chevron, folder, file-type, branch/tag/star icons.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TreeChevron, TreeFileIcon, TreeFolderIcon, TreeKindIcon } from '../../../src/client/ui/TreeIcons.tsx'

describe('TreeIcons', () => {
  it('chevron is an svg that reports its expanded state', () => {
    const open = renderToStaticMarkup(<TreeChevron expanded />)
    expect(open).toContain('<svg')
    expect(open).toContain('data-expanded="true"')
    expect(open).toContain('aria-hidden="true"')
    expect(renderToStaticMarkup(<TreeChevron expanded={false} />)).toContain('data-expanded="false"')
  })

  it('folder icon switches between open and closed', () => {
    expect(renderToStaticMarkup(<TreeFolderIcon open />)).toContain('data-tree-icon="folder-open"')
    expect(renderToStaticMarkup(<TreeFolderIcon open={false} />)).toContain('data-tree-icon="folder"')
  })

  it('file icon is classified from the path', () => {
    const html = renderToStaticMarkup(<TreeFileIcon path="src/client/index.ts" />)
    expect(html).toContain('data-tree-icon="file"')
    expect(html).toContain('<svg')
  })

  it('kind icons cover branch, tag, star and detached', () => {
    for (const kind of ['branch', 'remote', 'tag', 'current', 'detached'] as const) {
      const html = renderToStaticMarkup(<TreeKindIcon kind={kind} />)
      expect(html).toContain(`data-tree-icon="${kind}"`)
      expect(html).toContain('<svg')
    }
  })
})
