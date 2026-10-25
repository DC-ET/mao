// Mermaid 围栏占位（技术方案 2026-10-25-message-rendering §5.1）的 marked 层回归。
// 桌面 vitest 为 node 环境，这里在 createMarked 层断言占位结构；
// DOM 插入与 SVG 渲染在浏览器完成，不在本层。
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

function extractAttr(html: string, attr: string): string | null {
  const match = new RegExp(`${attr}="([^"]*)"`).exec(html)
  return match ? match[1] : null
}

describe('useMarkdown mermaid placeholder (marked layer)', () => {
  it('mermaid 围栏渲染为占位：初始内容为可复制的原代码块，不进入 colorize', async () => {
    const source = 'graph TD;\n  A-->B'
    const html = await parse(`\`\`\`mermaid\n${source}\n\`\`\``)
    expect(html).toContain('class="mermaid-block" data-mermaid="')
    // 占位内嵌完整原代码块：复制按钮 + data-code + monaco-code 主题类（评审 R1-2）
    expect(html).toContain('code-block')
    expect(html).toContain('code-copy-btn')
    expect(html).toContain('data-code="')
    expect(html).toContain('<code class="monaco-code aw-light">')
    // 占位内是转义后的源码原文（非 colorize 高亮产物）
    expect(html).toContain('A--&gt;B')
    // data-mermaid 解码即源码
    const encoded = extractAttr(html, 'data-mermaid')
    expect(encoded).not.toBeNull()
    expect(decodeB64(encoded!)).toBe(source)
  })

  it('mmd 别名与大写 / 带空格 lang 同样命中', async () => {
    expect(await parse('```mmd\ngraph TD\n```')).toContain('mermaid-block')
    expect(await parse('```Mermaid \ngraph TD\n```')).toContain('mermaid-block')
  })

  it('超过 64KB 的源码回落普通代码块（不产占位，不渲染）', async () => {
    const big = 'graph TD\n' + 'A-->B\n'.repeat(12000)
    expect(big.length).toBeGreaterThan(64 * 1024)
    const html = await parse('```mermaid\n' + big + '\n```')
    expect(html).not.toContain('mermaid-block')
    expect(html).toContain('data-code="')
  })

  it('行内 code 中的 mermaid 字样与代码块标记不受影响', async () => {
    expect(await parse('写法是 `mermaid`')).not.toContain('mermaid-block')
    const fenced = await parse('```text\nmermaid 围栏示例\n```')
    expect(fenced).not.toContain('mermaid-block')
  })

  it('未闭合围栏按 marked 语义整体成 code（历史 / 非流式路径不存在，流式由门控拦截）', async () => {
    const html = await parse('```mermaid\ngraph TD')
    expect(html).toContain('mermaid-block')
  })

  it('源码含 HTML / 引号等危险字符时占位内被转义（C 层消毒前的基础防线）', async () => {
    const source = 'graph TD\n  A["<img src=x onerror=alert(1)>"]'
    const html = await parse('```mermaid\n' + source + '\n```')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
    // 占位里的源码仍可完整解码（渲染层拿到的是原文）
    const encoded = extractAttr(html, 'data-mermaid')
    expect(decodeB64(encoded!)).toBe(source)
  })
})
