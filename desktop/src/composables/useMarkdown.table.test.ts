// 表格包裹层 + 复制工具条（技术方案 §5.4/P3）的 marked 层回归。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/monaco-colorize', () => ({
  colorizeCode: async (text: string) => `<code>${text}</code>`,
}))

const { createMarked } = await import('./useMarkdown')

async function parse(text: string): Promise<string> {
  return String(await createMarked(false).parse(text)).trim()
}

function decodeB64(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}

describe('useMarkdown table wrapper (marked layer)', () => {
  it('管道表渲染为带复制工具条的包裹层', async () => {
    const html = await parse('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |')
    expect(html).toContain('class="md-table-wrap"')
    expect(html).toContain('data-table-md="')
    expect(html).toContain('data-table-copy="markdown"')
    expect(html).toContain('data-table-copy="csv"')
    expect(html).toContain('<th>名称</th>')
    expect(html).toContain('<td>苹果</td>')
  })

  it('data-table-md 解码即原始表 markdown（复制 Markdown 保真）', async () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const html = await parse(source)
    const match = /data-table-md="([^"]*)"/.exec(html)
    expect(match).not.toBeNull()
    expect(decodeB64(match![1])).toBe(source)
  })

  it('对齐语法生效', async () => {
    const html = await parse('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')
    expect(html).toContain('style="text-align:left"')
    expect(html).toContain('style="text-align:center"')
    expect(html).toContain('style="text-align:right"')
  })

  it('单元格内加粗等内联格式走 parseInline', async () => {
    const html = await parse('| 名 | 值 |\n| --- | --- |\n| **粗** | [链](https://a.example.com) |')
    expect(html).toContain('<strong>粗</strong>')
    // 外链按既有规则带 _blank + noopener
    expect(html).toContain('<a href="https://a.example.com" target="_blank" rel="noopener noreferrer">链</a>')
  })

  it('超过 64KB 的原始表省略 data-table-md（复制回落 DOM 序列化）', async () => {
    const row = '| ' + 'x'.repeat(200) + ' | 1 |\n'
    const source = '| 长列 | n |\n| --- | --- |\n' + row.repeat(400)
    expect(source.length).toBeGreaterThan(64 * 1024)
    const html = await parse(source)
    expect(html).toContain('md-table-wrap')
    expect(html).not.toContain('data-table-md=')
  })

  it('非表格内容不包裹', async () => {
    expect(await parse('普通段落')).not.toContain('md-table-wrap')
  })
})
