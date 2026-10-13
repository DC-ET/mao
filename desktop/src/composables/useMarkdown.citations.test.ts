// 回复引用溯源（技术方案 2026-10-12）在 marked 渲染层的回归。
// 桌面 vitest 是 node 环境，跑不了依赖 window/DOMPurify 的 renderMarkdown 全链路，
// 这里直接在 marked 层断言 renderer 行为（三个历史 bug 都出在这一层）：
// (1) 带子 token 的 text（紧凑列表项）必须走 parseInline，否则整条消息渲染抛错；
// (2) 叶子 text 必须按 marked 默认语义转义，否则消息里的 HTML 实体被二次转义；
// (3) 链接文本内的 [^n^] 也必须转上标，不能原样泄漏。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/monaco-colorize', () => ({
  colorizeCode: async (text: string) => `<code>${text}</code>`,
}))

const { createMarked } = await import('./useMarkdown')

async function parse(text: string, citeMap?: Record<number, number>): Promise<string> {
  const out = await createMarked(false, citeMap).parse(text)
  return String(out).trim()
}

const SUP_1 = '<sup class="cite-ref" data-cite="1">[1]</sup>'

describe('useMarkdown citation rendering (marked layer)', () => {
  it('紧凑列表 / 任务列表 / 嵌套列表正常渲染（带子 token 的 text 走 parseInline）', async () => {
    expect(await parse('- 项目一\n- 项目二')).toContain('<li>项目一</li>')
    expect(await parse('1. 第一步\n2. 第二步')).toContain('<li>第一步</li>')
    expect(await parse('- [ ] 待办\n- [x] 完成')).toContain('type="checkbox"')
    expect(await parse('- 一级\n  - 二级')).toContain('<li>二级</li>')
  })

  it('列表项里的 [^n^] 同样转成上标', async () => {
    const html = await parse('- 结论一[^1^]\n- 结论二[^2^]', { 1: 1, 2: 2 })
    expect(html).toContain(SUP_1)
    expect(html).toContain('<sup class="cite-ref" data-cite="2">[2]</sup>')
    expect(html).not.toContain('[^1^]')
  })

  it('消息里已有的 HTML 实体不被二次转义（与默认 marked 一致）', async () => {
    const html = await parse('A &amp; B &lt;tag&gt; &copy; &#39;')
    expect(html).toContain('A &amp; B &lt;tag&gt; &copy; &#39;')
    expect(html).not.toContain('&amp;amp;')
    expect(html).not.toContain('&amp;copy;')
  })

  it('裸 < > & 仍被转义（不因实体感知放过真实 HTML 字符）', async () => {
    const html = await parse('A < B & C > D')
    expect(html).toContain('A &lt; B &amp; C &gt; D')
  })

  it('无 citeMap 时标记被剥掉、不留原样', async () => {
    expect(await parse('结论[^1^]。')).toBe('<p>结论。</p>')
  })

  it('越界 / 未映射的标记被剥掉，命中的仍转上标', async () => {
    const html = await parse('结论[^1^] 与 [^9^]。', { 1: 1 })
    expect(html).toBe(`<p>结论${SUP_1} 与 。</p>`)
  })

  it('链接文本内的 [^n^] 也转上标（不再原样泄漏在 <a> 里）', async () => {
    const html = await parse('见[政策页面[^1^]](https://a.example.com)', { 1: 1 })
    expect(html).toContain(SUP_1)
    expect(html).not.toContain('[^1^]')
  })

  it('链接在标记外时上标正常，链接本身不受影响', async () => {
    const html = await parse('见[政策](https://a.example.com)[^1^]。', { 1: 1 })
    expect(html).toContain('<a href="https://a.example.com" target="_blank" rel="noopener noreferrer">政策</a>')
    expect(html).toContain(SUP_1)
  })

  it('javascript: 等危险协议链接降级为纯文本，其中的标记照常处理', async () => {
    const html = await parse('点[这里[^1^]](javascript:alert(1))', { 1: 1 })
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain(SUP_1)
  })

  it('行内代码与代码块里的标记不转换（保持字面量）', async () => {
    expect(await parse('写法是 `[^1^]`', { 1: 1 })).toContain('<code>[^1^]</code>')
    const fenced = await parse('```\n[^1^]\n```', { 1: 1 })
    expect(fenced).toContain('[^1^]')
    expect(fenced).not.toContain('cite-ref')
  })

  it('模型混用脚注语法写的定义行被整行剥掉：不再出现「上标 + : 链接」残句', async () => {
    // 与正文同段（无空行分隔）时 marked 不会把定义行当引用定义消费，只能 parse 前按行删
    const html = await parse('结论如上[^1^]\n[^1^]: https://a.example.com\n\n后续段落', { 1: 1 })
    expect(html).toContain(SUP_1)
    expect(html).not.toContain('https://a.example.com')
    expect(html).not.toContain(': http')
    expect(html).toContain('后续段落')
  })

  it('文末独立成段的定义行同样不渲染', async () => {
    const html = await parse('结论如上[^1^]\n\n[^1^]: https://a.example.com\n[^2^]: https://b.example.com', { 1: 1, 2: 2 })
    expect(html).toContain(SUP_1)
    expect(html).not.toContain('https://a.example.com')
    expect(html).not.toContain('https://b.example.com')
  })

  it('句内「说法[^1^]：……」不是定义行，照常渲染（行首锚定）', async () => {
    const html = await parse('说明[^1^]: 这是结论', { 1: 1 })
    expect(html).toContain(': 这是结论')
    expect(html).toContain(SUP_1)
  })
})
