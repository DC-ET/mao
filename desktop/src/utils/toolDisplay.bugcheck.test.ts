import { describe, expect, it } from 'vitest'
import { getToolInputPreview } from './toolDisplay'

/**
 * 工具参数预览必须与后端工具真实入参字段一致。
 *
 * 后端 schema（backend-ts/src/harness/tool/impl）：
 * - page-tools.ts `PageObserveTool.getInputSchema()` → { snapshotId }
 * - page-tools.ts `PageInspectTool.getInputSchema()` → { includeHidden }
 * - page-tools.ts `PageScreenshotTool.getInputSchema()` → { maskSensitive, reason }
 * - open-web-page-tool.ts `OpenWebPageTool.getInputSchema()` → { url }（required）
 *
 * 桌面端 getToolInputPreview 把 page_inspect / page_observe / page_screenshot 归到同一个
 * `reason` 分支，但 reason 只有 page_screenshot 才有；page_observe 的真实入参 snapshotId
 * 与 open_web_page 的 url 都没有任何分支，通用兜底（command/pattern/path/file_path/query/
 * agent_type/task）也不含 url → 这些工具卡片永远不显示参数。
 */
describe('工具参数预览与后端真实入参字段一致', () => {
  it('page_observe 展示真实入参 snapshotId（不是不存在的 reason）', () => {
    const preview = getToolInputPreview('page_observe', { snapshotId: 'snap-42' })
    expect(preview).toContain('snap-42')
  })

  it('open_web_page 展示真实入参 url', () => {
    const preview = getToolInputPreview('open_web_page', { url: 'https://example.com/guide/intro' })
    expect(preview).toContain('https://example.com/guide/intro')
  })

  it('page_screenshot 的 reason 仍然有效（不能被上面两条修复误伤）', () => {
    expect(getToolInputPreview('page_screenshot', { reason: '确认订单页' })).toBe('确认订单页')
  })
})
