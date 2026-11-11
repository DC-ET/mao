// 标记 → 编辑器标签 HTML 的纯函数（技术方案 2026-11-11-message-edit-quick-command-tags §4.1）：
// 自 ChatInput 原样搬迁（搬迁校验：与原实现逐字节 diff 一致），行为由本文件锁定。
import { describe, expect, it } from 'vitest'
import { escapeHtml, markedTextToEditorHtml } from './editor-tags'

describe('markedTextToEditorHtml', () => {
  it('三种标记单独出现 → 对应 span 标签节点', () => {
    expect(markedTextToEditorHtml('#{talk}#'))
      .toBe('<span data-quick-command data-command-type="command" data-command-name="talk">talk</span>')
    expect(markedTextToEditorHtml('${code}$'))
      .toBe('<span data-quick-command data-command-type="skill" data-command-name="code">code</span>')
    expect(markedTextToEditorHtml('@{p/a.ts}@'))
      .toBe('<span data-file-reference data-file-path="p/a.ts">a.ts</span>')
  })

  it('相邻/混合/首尾：每段独立切分为节点，文本段保留', () => {
    const html = markedTextToEditorHtml('前#{a}#${b}$@{c}@尾')
    expect(html.startsWith('前')).toBe(true)
    expect(html.endsWith('尾')).toBe(true)
    expect(html).toContain('<span data-quick-command data-command-type="command" data-command-name="a">a</span>')
    expect(html).toContain('<span data-quick-command data-command-type="skill" data-command-name="b">b</span>')
    expect(html).toContain('<span data-file-reference data-file-path="c">c</span>')
  })

  it('无标记文本恒等；HTML 元字符转义', () => {
    expect(markedTextToEditorHtml('plain text')).toBe('plain text')
    expect(markedTextToEditorHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;')
  })

  it('空串 → 空串', () => {
    expect(markedTextToEditorHtml('')).toBe('')
  })

  it('文本段 \\n → <br>', () => {
    expect(markedTextToEditorHtml('a\nb')).toBe('a<br>b')
    expect(markedTextToEditorHtml('a\n\nb')).toBe('a<br><br>b')
  })

  it('标记名内的引号被转义进 data 属性', () => {
    const html = markedTextToEditorHtml('#{a"b}#')
    expect(html).toContain('data-command-name="a&quot;b"')
    expect(html).toContain('>a&quot;b</span>')
  })

  it('escapeHtml 直测', () => {
    expect(escapeHtml('<>&"')).toBe('&lt;&gt;&amp;&quot;')
    expect(escapeHtml('plain')).toBe('plain')
  })
})
