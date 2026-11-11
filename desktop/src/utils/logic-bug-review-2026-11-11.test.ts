/**
 * 2026-11-11 逻辑 BUG 审查——存在性证明用例（详见 docs/code-review/2026-11-11-logic-bug-review-01.md）。
 *
 * 本文件以「存在性证明」形态落地：用例断言正确契约、当前实现必然失败，以 it.fails
 * 固化（expected-failure 通过，CI 保持绿色）；把 bugIt 改成 it 再跑即得真实失败输出。
 * 对应 BUG 修复后转正为常规断言（与 backend-ts logic-bug-review spec 生命周期同款）。
 */
/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { convertHtmlToMarkdown, ensureHtmlConverter } from './html-to-markdown'

const bugIt = it.fails // 存在性证明：当前实现必失败（expected-failure 保持 CI 绿）；修复后转 it

// ---------------------------------------------------------------------------
// BUG-4（中）表格单元格内容含 `|` 未转义——GFM 表格列结构被撑破
// 位置：desktop/src/utils/html-to-markdown.ts（turndown-plugin-gfm tables 规则原样输出 cell 文本）
// 契约：GFM 表格单元格内的 `|` 必须转义为 `\|`（CommonMark GFM spec：管道符是单元格分隔符，
//       不转义即拆列）。富文本粘贴转 Markdown 后由桌面渲染层按 GFM 渲染，列结构必须与
//       原表格一致。
// 实际：turndown-plugin-gfm 的 cell replacement 不做管道转义，`a|b` 原样落进单元格，
//       渲染时 `| a|b |` 被解析成 2 列——表格列错位、后续行全部串列。
// 触发场景：从 Excel / Word / 网页复制含竖线的表格（如「A|B 测试组」「key|value」）
//       粘贴进输入框 → 转换出的 Markdown 表格在会话里渲染错位。
// 修复方向：转换后对表格 cell 文本补 `|` → `\|` 转义（在 gfm tables 规则外层包一层
//           cell replacement，或转换后按行还原表格局部转义）。
// ---------------------------------------------------------------------------
describe('BUG-4: 富文本粘贴转 Markdown 的表格单元格 `|` 未转义', () => {
  bugIt('单元格内容含 `|` 时必须转义为 `\\|`，保住列结构', async () => {
    await ensureHtmlConverter()
    const md = convertHtmlToMarkdown(
      '<table><thead><tr><th>a|b</th><th>c</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
    expect(md).not.toBeNull()
    // 正确契约：管道符转义，表头仍是 2 列
    expect(md!, '表头单元格里的 | 未转义，渲染时会把 1 列拆成 2 列').toContain('a\\|b')
    // 未转义的裸管道必须不存在（否则列结构已破）
    expect(md!).not.toMatch(/a\|b/)
  })
})
