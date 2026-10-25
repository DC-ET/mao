// @vitest-environment jsdom
// 消毒全链锁定（技术方案 §6-B1/B3/B4/F1）：
// - 占位 / 表格包裹层的 data-* 属性经主链口径的 DOMPurify 后存活（B1）；
// - KaTeX 的 MathML + inline style 经默认 profile 存活（B4）；
// - mermaid SVG 的恶意构造（script / foreignObject / 事件属性）被剥、内嵌 style 保留（B3/F1）。
// 桌面 vitest 全局是 node 环境，本文件用 jsdom 环境Pragma 单独开启 DOM。
import { describe, expect, it } from 'vitest'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { buildMermaidPlaceholder, SVG_SANITIZE_OPTIONS } from './mermaid-renderer'
import { renderMarkdownTable } from './markdown-table'

// 与 useMarkdown.ts 主链 SANITIZE_OPTIONS 同口径
const MAIN_SANITIZE_OPTIONS = { ADD_ATTR: ['target'] }

function fakeTableToken(): Parameters<typeof renderMarkdownTable>[0] {
  return {
    type: 'table',
    raw: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    align: [null, null],
    header: [
      { type: 'tablecell', raw: 'a', tokens: [{ type: 'text', raw: 'a', text: 'a' }] },
      { type: 'tablecell', raw: 'b', tokens: [{ type: 'text', raw: 'b', text: 'b' }] },
    ],
    rows: [[
      { type: 'tablecell', raw: '1', tokens: [{ type: 'text', raw: '1', text: '1' }] },
      { type: 'tablecell', raw: '2', tokens: [{ type: 'text', raw: '2', text: '2' }] },
    ]],
  } as unknown as Parameters<typeof renderMarkdownTable>[0]
}

describe('markdown 富渲染消毒全链 (jsdom)', () => {
  it('mermaid 占位经主链消毒后 data-mermaid / data-code / 复制按钮存活（B1）', () => {
    const placeholder = buildMermaidPlaceholder('graph TD;\n  A-->B', false)
    const clean = DOMPurify.sanitize(placeholder, MAIN_SANITIZE_OPTIONS)
    expect(clean).toContain('data-mermaid="')
    expect(clean).toContain('data-code="')
    expect(clean).toContain('code-copy-btn')
    expect(clean).toContain('mermaid-block')
  })

  it('表格包裹层经主链消毒后 data-table-md / 工具条按钮存活（B1）', () => {
    const html = renderMarkdownTable(fakeTableToken(), (tokens) => String((tokens[0] as { text: string }).text))
    const clean = DOMPurify.sanitize(html, MAIN_SANITIZE_OPTIONS)
    expect(clean).toContain('data-table-md="')
    expect(clean).toContain('table-copy-btn')
    expect(clean).toContain('<th>a</th>')
    expect(clean).toContain('<td>1</td>')
  })

  it('KaTeX 产物经主链消毒后 katex 结构与 MathML 存活（B4）', () => {
    const rendered = katex.renderToString('x^2', {
      displayMode: false,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    })
    const clean = DOMPurify.sanitize(rendered, MAIN_SANITIZE_OPTIONS)
    expect(clean).toContain('class="katex"')
    expect(clean).toContain('<math')
    expect(clean).toContain('katex-html')
  })

  it('恶意 mermaid SVG：script / foreignObject / 事件属性被剥，style 与文本保留（B3/F1）', () => {
    const evil = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">',
      '<style>.a { fill: red; }</style>',
      '<g><script>alert(1)</script>',
      '<text onerror="alert(1)" onclick="alert(1)">节点A</text>',
      '<foreignObject><body><img src=x onerror="alert(1)"></body></foreignObject>',
      '</g></svg>',
    ].join('')
    const clean = DOMPurify.sanitize(evil, SVG_SANITIZE_OPTIONS)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('foreignObject')
    expect(clean).not.toContain('onerror')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('<img')
    expect(clean).toContain('<style>')
    expect(clean).toContain('节点A')
  })

  it('合法 mermaid SVG 产物形状在消毒后完整保留（svg 结构 / 类名 / 节点文本）', () => {
    const good = '<svg xmlns="http://www.w3.org/2000/svg" id="mao-mermaid-1" viewBox="0 0 100 50">' +
      '<style>#mao-mermaid-1 { fill: blue; }</style><g class="node"><text>开始</text></g></svg>'
    const clean = DOMPurify.sanitize(good, SVG_SANITIZE_OPTIONS)
    expect(clean).toContain('viewBox="0 0 100 50"')
    expect(clean).toContain('class="node"')
    expect(clean).toContain('开始')
  })
})
