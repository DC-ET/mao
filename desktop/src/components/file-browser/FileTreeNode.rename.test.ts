import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import FileTreeNode from './FileTreeNode.vue'

describe('FileTreeNode rename draft', () => {
  it('uses the file name when the row label is a search path', async () => {
    const html = await renderToString(createSSRApp({
      render() {
        return h(FileTreeNode, {
          node: { name: 'src/a.ts', path: 'src/a.ts', isDirectory: false },
          depth: 0,
          canWrite: true,
          renamePath: 'src/a.ts',
        })
      },
    }))
    expect(html).toContain('value="a.ts"')
  })
})
