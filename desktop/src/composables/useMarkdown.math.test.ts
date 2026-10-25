// KaTeX 数学公式扩展（技术方案 §5.3）的 marked 层回归：定界规则、价格语境不误判、
// code/codespan 豁免、katex 未加载回落原文。node 环境直接动态加载 katex（CSS 被 vitest stub）。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/monaco-colorize', () => ({
  colorizeCode: async (text: string) => `<code>${text}</code>`,
}))

const katexLoader = await import('../utils/katex-loader')
await katexLoader.ensureKatex()
const { createMarked } = await import('./useMarkdown')

async function parse(text: string, citeMap?: Record<number, number>): Promise<string> {
  return String(await createMarked(false, citeMap).parse(text)).trim()
}

afterEach(async () => {
  // 「未加载回落」用例会把 katex 置空，这里恢复真实实例，避免污染后续用例
  const real = (await import('katex')).default
  katexLoader.setKatexForTest(real)
})

describe('useMarkdown math extension (marked layer)', () => {
  it('行内 $...$ 渲染为 katex', async () => {
    const html = await parse('质能方程 $E=mc^2$ 很有名')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$E=mc^2$')
  })

  it('块级 $$...$$ 渲染 display 模式', async () => {
    const html = await parse('$$\nx^2 + y^2 = z^2\n$$')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$$')
  })

  it('块级惰性闭合不跨行吞并正文（评审 R1-1）：行内 $$a$$ + 尾随文字与后续独立公式块互不干扰', async () => {
    const html = await parse('$$a$$ 说明文字\n$$b$$')
    // 第一行：行内 $$a$$ 出图（display），「说明文字」保持正文
    expect(html).toContain('katex-display')
    expect(html).toContain('说明文字')
    // 第二行：独立公式块正常出图，没有被吞进上一条而消失
    expect(html).not.toContain('katex-error')
    expect(html).not.toContain('$$')
  })

  it('单行块 $$x$$ 整行时按 display 渲染；多行块前后行独占 $$ 正常', async () => {
    expect(await parse('$$x$$')).toContain('katex-display')
    const multiline = await parse('$$\nE=mc^2\n$$')
    expect(multiline).toContain('katex-display')
    expect(multiline).toContain('E=mc')
  })

  it('行内 $$...$$ 按 display 渲染', async () => {
    expect(await parse('公式 $$x$$ 结束')).toContain('katex-display')
  })

  it('价格语境不误判：$5 和 $6 保持原文', async () => {
    const html = await parse('价格 $5 和 $6 不等')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5 和 $6')
  })

  it('纯数字内容不渲染（$2$ 是价格写法不是公式）', async () => {
    const html = await parse('编号 $2$ 见附录')
    expect(html).not.toContain('katex')
    expect(html).toContain('$2$')
  })

  it('开 / 闭定界贴空白不渲染（$ x $）', async () => {
    const html = await parse('间距 $ x $ 保留')
    expect(html).not.toContain('katex')
    expect(html).toContain('$ x $')
  })

  it('行内公式不跨行（$x\\ny$ 保持原文）', async () => {
    const html = await parse('$x\ny$ 尾随')
    expect(html).not.toContain('katex')
  })

  it('codespan 与代码块豁免', async () => {
    const inline = await parse('写法 `$x^2$` 是字面量')
    expect(inline).toContain('<code>$x^2$</code>')
    expect(inline).not.toContain('class="katex"')
    const fenced = await parse('```\n$x^2$\n```')
    expect(fenced).toContain('$x^2$')
    expect(fenced).not.toContain('class="katex"')
  })

  it('转义 \\$ 不触发公式', async () => {
    const html = await parse('\\$x^2$ 尾')
    expect(html).not.toContain('class="katex"')
  })

  it('块级公式未闭合时回落原文', async () => {
    const html = await parse('$$\nx + y')
    expect(html).not.toContain('katex')
    expect(html).toContain('$$')
  })

  it('超长公式回落原文（MATH_SOURCE_CAP）', async () => {
    const long = '$' + 'x'.repeat(11 * 1024) + '$'
    const html = await parse(long)
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$xxx')
  })

  it('katex 未加载时回落原文（加载失败 / hint 漏判兜底）', async () => {
    const real = (await import('katex')).default
    katexLoader.setKatexForTest(null)
    const html = await parse('$E=mc^2$')
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$E=mc^2$')
    katexLoader.setKatexForTest(real)
    expect(await parse('$E=mc^2$')).toContain('class="katex"')
  })

  it('公式旁的 [^n^] 照常转上标（math token 不干扰 citation）', async () => {
    const html = await parse('$a^2$ 见[^1^]', { 1: 1 })
    expect(html).toContain('class="katex"')
    expect(html).toContain('cite-ref')
  })
})
