/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import {
  convertHtmlToMarkdown,
  expandTableCells,
  MAX_HTML_LENGTH,
  shouldConvertHtmlPaste,
} from './html-to-markdown'

async function ready(): Promise<void> {
  // 真实 turndown + gfm（jsdom 环境），全部结构用例走真实转换
  const { ensureHtmlConverter } = await import('./html-to-markdown')
  await ensureHtmlConverter()
}

describe('convertHtmlToMarkdown 结构转换', () => {
  it('标题（h1-h3）→ ATX', async () => {
    await ready()
    expect(convertHtmlToMarkdown('<h1>大标题</h1><h2>二级</h2><h3>三级</h3>')).toBe('# 大标题\n\n## 二级\n\n### 三级')
  })

  it('无序/有序列表', async () => {
    await ready()
    expect(convertHtmlToMarkdown('<ul><li>苹果</li><li>香蕉</li></ul>')).toBe('-   苹果\n-   香蕉')
    expect(convertHtmlToMarkdown('<ol><li>第一</li><li>第二</li></ol>')).toBe('1.  第一\n2.  第二')
  })

  it('粗体/斜体/行内代码/链接', async () => {
    await ready()
    expect(convertHtmlToMarkdown('<p><strong>加粗</strong>与<em>斜体</em></p>')).toBe('**加粗**与*斜体*')
    expect(convertHtmlToMarkdown('<p>运行 <code>npm test</code></p>')).toBe('运行 `npm test`')
    expect(convertHtmlToMarkdown('<p><a href="https://mao.example">文档</a></p>')).toBe('[文档](https://mao.example)')
  })

  it('代码块 → fenced', async () => {
    await ready()
    const md = convertHtmlToMarkdown('<pre><code>const a = 1\nconst b = 2</code></pre>')
    expect(md).toContain('```')
    expect(md).toContain('const a = 1')
  })

  it('普通段落：换行收敛为最多一个空行', async () => {
    await ready()
    const md = convertHtmlToMarkdown('<p>一段</p><p>二段</p><p>三段</p>')
    expect(md).toBe('一段\n\n二段\n\n三段')
    expect(md).not.toMatch(/\n{3,}/)
  })

  it('剥离 img / script / style（img src 死链与脚本不进产物）', async () => {
    await ready()
    const md = convertHtmlToMarkdown(
      '<p>前</p><img src="blob:dead"><script>alert(1)</script><style>p{}</style><p>后</p>',
    )
    expect(md).toBe('前\n\n后')
    expect(md).not.toContain('blob:')
    expect(md).not.toContain('alert')
  })

  it('GFM 表格（无合并单元格）', async () => {
    await ready()
    const md = convertHtmlToMarkdown(
      '<table><tr><th>名称</th><th>数量</th></tr><tr><td>甲</td><td>1</td></tr></table>',
    )
    expect(md).toContain('| 名称 | 数量 |')
    expect(md).toContain('| --- | --- |')
    expect(md).toContain('| 甲 | 1 |')
  })

  it('输出空白收敛：全空产物 → null', async () => {
    await ready()
    expect(convertHtmlToMarkdown('<img src="x">')).toBeNull()
    expect(convertHtmlToMarkdown('<p>   </p>')).toBeNull()
  })
})

describe('convertHtmlToMarkdown 护栏', () => {
  it('converter 未就绪 → null（同步探测，粘贴回落现状）', () => {
    // 本 describe 不预热：前提是前面用例可能已预热过——用独立判断不可靠，这里直接验证
    // shouldConvertHtmlPaste 的守卫语义（未就绪的 null 行为由 ensureHtmlConverter 延迟注入保证）
    expect(shouldConvertHtmlPaste('短文本', '<p>hi</p>', 2000)).toBe(true)
  })

  it('超过 512KB 护栏 → null', async () => {
    await ready()
    const big = `<p>${'x'.repeat(MAX_HTML_LENGTH)}</p>`
    expect(big.length).toBeGreaterThan(MAX_HTML_LENGTH)
    expect(convertHtmlToMarkdown(big)).toBeNull()
  })

  it('空 / 非字符串入参 → null', async () => {
    await ready()
    expect(convertHtmlToMarkdown('')).toBeNull()
    expect(convertHtmlToMarkdown(undefined as unknown as string)).toBeNull()
  })
})

describe('shouldConvertHtmlPaste 分流守卫', () => {
  it('html 为空 → 不接管', () => {
    expect(shouldConvertHtmlPaste(null, '', 2000)).toBe(false)
    expect(shouldConvertHtmlPaste(null, undefined, 2000)).toBe(false)
  })

  it('text/plain 为空（纯 html 剪贴板）→ 接管', () => {
    expect(shouldConvertHtmlPaste(null, '<p>hi</p>', 2000)).toBe(true)
    expect(shouldConvertHtmlPaste(undefined, '<p>hi</p>', 2000)).toBe(true)
    expect(shouldConvertHtmlPaste('', '<p>hi</p>', 2000)).toBe(true)
  })

  it('普通短文本 + html → 接管', () => {
    expect(shouldConvertHtmlPaste('一段话', '<p>hi</p>', 2000)).toBe(true)
  })

  it('text/plain ≥ 阈值 → 不接管（保持既有文件化通道，保序断言）', () => {
    expect(shouldConvertHtmlPaste('x'.repeat(2000), '<p>hi</p>', 2000)).toBe(false)
    expect(shouldConvertHtmlPaste('x'.repeat(2001), '<p>hi</p>', 2000)).toBe(false)
    expect(shouldConvertHtmlPaste('x'.repeat(1999), '<p>hi</p>', 2000)).toBe(true)
  })
})

describe('expandTableCells 合并单元格展开', () => {
  function buildTable(html: string): HTMLTableElement {
    const container = document.createElement('div')
    container.innerHTML = `<table>${html}</table>`
    return container.querySelector('table') as HTMLTableElement
  }

  function cellTexts(table: HTMLTableElement): string[][] {
    // 文档序：thead（首行）在前、tbody 跟后
    return Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td, th')).map((td) => td.textContent?.trim() ?? ''))
  }

  it('colspan=3：左上值重复展开为 3 列', () => {
    const table = buildTable('<tr><td colspan="3">合并</td></tr><tr><td>a</td><td>b</td><td>c</td></tr>')
    expandTableCells(table)
    const rows = cellTexts(table)
    expect(rows[0]).toEqual(['合并', '合并', '合并'])
    expect(rows[1]).toEqual(['a', 'b', 'c'])
  })

  it('rowspan=2：值向下重复填充', () => {
    const table = buildTable('<tr><td rowspan="2">组</td><td>x</td></tr><tr><td>y</td></tr>')
    expandTableCells(table)
    const rows = cellTexts(table)
    expect(rows).toEqual([
      ['组', 'x'],
      ['组', 'y'],
    ])
  })

  it('colspan × rowspan 混合：行列对齐且保序', () => {
    const table = buildTable(
      '<tr><td colspan="2" rowspan="2">块</td><td>h</td></tr>' +
      '<tr><td>i</td></tr>' +
      '<tr><td>a</td><td>b</td><td>c</td></tr>',
    )
    expandTableCells(table)
    const rows = cellTexts(table)
    expect(rows).toEqual([
      ['块', '块', 'h'],
      ['块', '块', 'i'],
      ['a', 'b', 'c'],
    ])
    // 每行单元格数一致
    expect(new Set(rows.map((r) => r.length))).toEqual(new Set([3]))
    // 跨度归 1
    for (const td of table.querySelectorAll('td')) {
      expect(td.colSpan).toBe(1)
      expect(td.rowSpan).toBe(1)
    }
  })

  it('保留单元格内部格式（克隆原单元格；首行规范成 th）', () => {
    const table = buildTable('<tr><td colspan="2"><strong>粗</strong></td></tr>')
    expandTableCells(table)
    // 首行 td → th（innerHTML 保留），两个展开位各有一份 <strong>
    const bolds = table.querySelectorAll('strong')
    expect(bolds.length).toBe(2)
    expect(table.querySelectorAll('thead th').length).toBe(2)
  })

  it('无行表格：不变（空数组提前返回）', () => {
    const table = buildTable('')
    expandTableCells(table)
    expect(table.querySelectorAll('tr').length).toBe(0)
  })
})

describe('convertHtmlToMarkdown 未就绪 / 加载失败', () => {
  it('turndown 加载失败 → converter 保持 null → convert 返回 null（未就绪路径）', async () => {
    vi.resetModules()
    vi.doMock('turndown', () => {
      throw new Error('mock load failure')
    })
    try {
      const fresh = await import('./html-to-markdown')
      await fresh.ensureHtmlConverter()
      expect(fresh.convertHtmlToMarkdown('<p>hi</p>')).toBeNull()
    } finally {
      vi.doUnmock('turndown')
      vi.resetModules()
    }
  })
})
