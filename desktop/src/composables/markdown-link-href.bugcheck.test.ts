import { describe, expect, it } from 'vitest'
import { createMarked } from './useMarkdown'

/**
 * FileViewer.vue:50,119-141 用 MarkdownContent 渲染工作区 Markdown，并在容器上
 * 委托 click：从 <a href> 取相对路径，经 resolveMarkdownLink 打开同工作区文件。
 * 因此相对链接必须保留 href；mailto 由 isExternalMarkdownLink / 外链委托接管。
 */
describe('createMarked link renderer', () => {
  it('对照组：http(s) 外链保留 href', async () => {
    const html = await createMarked(false).parse('[官网](https://example.com/a)')
    expect(html).toContain('href="https://example.com/a"')
  })

  it('回归：工作区相对链接应保留 href，否则 FileViewer 点击无反应', async () => {
    const html = await createMarked(false).parse('[另一篇](./other.md)')
    expect(html).toContain('href="./other.md"')
  })

  it('回归：mailto 应保留 href（isExternalMarkdownLink 明确把它当外链）', async () => {
    const html = await createMarked(false).parse('[邮件](mailto:a@b.com)')
    expect(html).toContain('href="mailto:a@b.com"')
  })

  it('回归：javascript: 仍必须降级为纯文本', async () => {
    const html = await createMarked(false).parse('[点我](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('点我')
  })
})
