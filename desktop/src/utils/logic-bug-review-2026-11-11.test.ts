/**
 * 2026-11-11 逻辑 BUG 审查——BUG-4 回归用例
 * （详见 docs/code-review/2026-11-11-logic-bug-review-01.md）。
 *
 * 原为 it.fails 存在性证明；表格 cell 管道符转义落地后已转正为常规断言。
 */
/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { convertHtmlToMarkdown, ensureHtmlConverter } from './html-to-markdown'

// ---------------------------------------------------------------------------
// BUG-4（中）表格单元格内容含 `|` 未转义——GFM 表格列结构被撑破
// 位置：desktop/src/utils/html-to-markdown.ts（turndown-plugin-gfm tables 规则原样输出 cell 文本）
// 契约：GFM 表格单元格内的 `|` 必须转义为 `\|`（CommonMark GFM spec：管道符是单元格分隔符，
//       不转义即拆列）。富文本粘贴转 Markdown 后由桌面渲染层按 GFM 渲染，列结构必须与
//       原表格一致。
// 修复：覆盖 gfm 的 tableCell 规则，输出前把 cell 文本里的 | 转成 \|；表头与表体同规则。
// ---------------------------------------------------------------------------
describe('BUG-4: 富文本粘贴转 Markdown 的表格单元格 `|` 未转义', () => {
  it('单元格内容含 `|` 时必须转义为 `\\|`，保住列结构', async () => {
    await ensureHtmlConverter()
    const md = convertHtmlToMarkdown(
      '<table><thead><tr><th>a|b</th><th>c</th></tr></thead>'
        + '<tbody><tr><td>1|2</td><td>3</td></tr></tbody></table>',
    )
    expect(md).not.toBeNull()
    // 表头与表体都要转义，且仍是两列
    expect(md!, '表头单元格里的 | 未转义，渲染时会把 1 列拆成 2 列').toContain('| a\\|b | c |')
    expect(md!, '表体单元格里的 | 未转义，渲染时会多出一列').toContain('| 1\\|2 | 3 |')
    // 未转义的裸管道必须不存在（否则列结构已破）
    expect(md!).not.toMatch(/a\|b/)
    expect(md!).not.toMatch(/1\|2/)
  })
})
