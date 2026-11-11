/**
 * @vitest-environment jsdom
 */
// GFM 任务列表产物锁定（技术方案 2026-11-11-markdown-render-polish §4.4-2）：
// 「marked gfm 管线产出 input checkbox + DOMPurify 放行」是任务列表 CSS（:has 选择器）
// 的前提——marked 升级或渲染配置漂移在这里报警。
import { describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'

vi.mock('../utils/monaco-colorize', () => ({
  colorizeCode: async (text: string) => `<code>${text}</code>`,
}))

const { createMarked } = await import('./useMarkdown')

describe('useMarkdown task list (marked layer)', () => {
  it('- [ ] / - [x] / - [X] 产出 input checkbox（disabled 只读）', async () => {
    const html = String(await createMarked(false).parse('- [ ] 待办\n- [x] 已完成\n- [X] 大写完成'))
    expect(html).toContain('<input disabled="" type="checkbox">')
    expect(html).toContain('<input checked="" disabled="" type="checkbox">')
    expect((html.match(/<input /g) ?? []).length).toBe(3)
  })

  it('DOMPurify 放行 input 且保留 checked/disabled——CSS :has 选择器依赖的前提', () => {
    const raw = '<ul>\n<li><input checked="" disabled="" type="checkbox"> 已完成</li>\n</ul>'
    const clean = DOMPurify.sanitize(raw)
    expect(clean).toContain('<input checked="" disabled="" type="checkbox">')
    expect(clean).toContain('已完成')
  })
})
