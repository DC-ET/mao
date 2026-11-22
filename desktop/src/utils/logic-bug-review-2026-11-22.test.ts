import { describe, expect, it } from 'vitest'

/**
 * 2026-11-22 逻辑 BUG 审查的存在性验证用例（对应 docs/code-review/2026-11/2026-11-22-logic-bug-review-01.md）。
 *
 * 惯例同 logic-bug-review-2026-11-11：用例按「正确契约」书写，在缺陷代码上真实失败即确认缺陷。
 * DESKTOP-BUG-1/2 确认后当日修复（nextHunkIndex 初值反向映射、parseCsv 拖尾空行不误报），
 * 已转正为普通 it 回归。
 */
import { nextHunkIndex } from './diff-view-mode'
import { parseCsv } from './csv-parse'

// ────────────────────────────────────────────────────────────────────────────
// DESKTOP-BUG-1 diff 变更跳转游标「首次反向」差一
// FileDiffViewer 打开文件 / 切换模型后 hunkIndex=-1，第一次按 ↑（上一处变更）
// 应循环落到最后一处变更（total-1），实际落到 total-2，跳过末处。
// ────────────────────────────────────────────────────────────────────────────

describe('nextHunkIndex（diff 变更跳转游标）', () => {
  it('首次正向从未选中跳到第一处（现状正确，防回归锚点）', () => {
    expect(nextHunkIndex(-1, 3, 1)).toBe(0)
    expect(nextHunkIndex(-1, 1, 1)).toBe(0)
  })

  it('首次反向从未选中应循环到最后一处变更（total-1）（2026-11-22 审查 DESKTOP-BUG-1，已修复转正）', () => {
    expect(nextHunkIndex(-1, 3, -1)).toBe(2)
    expect(nextHunkIndex(-1, 2, -1)).toBe(1)
  })

  it('已选中状态的双向循环步进（现状正确，防回归锚点）', () => {
    expect(nextHunkIndex(2, 3, 1)).toBe(0)
    expect(nextHunkIndex(0, 3, -1)).toBe(2)
    expect(nextHunkIndex(1, 3, -1)).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// DESKTOP-BUG-2 CSV 行数上限的 truncated 标志对「拖尾空行」误报
// 恰好 5000 行数据、文件末尾多一个空行：没有任何数据行被丢弃，
// 实际仍标记 truncated=true，工具结果表格 / 文件预览会错误显示「已截断」。
// ────────────────────────────────────────────────────────────────────────────

describe('parseCsv（行数上限与 truncated 标志）', () => {
  const rows5000 = Array.from({ length: 5000 }, (_, i) => `r${i},x`).join('\n')

  it('恰好 5000 行且末尾单个换行：不截断（现状正确，防回归锚点）', () => {
    const result = parseCsv(`${rows5000}\n`)
    expect(result.rows).toHaveLength(5000)
    expect(result.truncated).toBe(false)
  })

  it('恰好 5000 行 + 末尾空行：内容零丢失，不应标记 truncated（2026-11-22 审查 DESKTOP-BUG-2，已修复转正）', () => {
    const result = parseCsv(`${rows5000}\n\n`)
    expect(result.rows).toHaveLength(5000)
    expect(result.truncated).toBe(false)
  })

  it('第 5001 行为真实数据行：truncated=true（现状正确，防回归锚点）', () => {
    const result = parseCsv(`${rows5000}\nr5000,y\n`)
    expect(result.rows).toHaveLength(5000)
    expect(result.truncated).toBe(true)
  })
})
