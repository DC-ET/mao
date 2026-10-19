/**
 * 工作区文件弹窗高度分配的布局回归（纯 CSS 层，无需后端）。
 *
 * 背景：用户反馈「dialog 有点扁，可见内容偏少」。根因是内容区写死
 * max-height: 44vh，且 el-dialog__body / .wf-body / .wf-panel 未构成
 * 完整的 flex 收缩链，flex:1 实际不生效。
 *
 * 本用例锁定修复后的结构：el-dialog(flex column, max-height 92vh)
 *   > header(fixed) + body(flex column, min-height 0)
 *     > .wf-body(flex:1, min-height 0, column)
 *       > breadcrumb(fixed) + 内容区(flex:1, min-height 0, overflow auto)
 * 内容区必须吃掉弹窗剩余全部高度，而不是被 vh 常量限低。
 */
import { test, expect } from '@playwright/test'

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root { --el-fill-color-light: #f5f5f5; }
html, body { margin: 0; height: 100%; }
.overlay { position: fixed; inset: 0; display: flex; }
.el-dialog {
  width: 1080px; margin: 4vh auto 0;
  max-height: 92vh;
  display: flex; flex-direction: column;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2);
}
.el-dialog__header { flex-shrink: 0; padding: 16px; }
.el-dialog__body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; padding: 10px; }
.wf-body { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.wf-breadcrumb { flex-shrink: 0; padding: 6px 10px; background: var(--el-fill-color-light); }
.wf-table-wrap, .wf-grid-wrap { flex: 1 1 auto; min-height: 0; overflow: auto; }
.wf-table-wrap { min-height: 120px; }
.wf-grid-wrap { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 4px; padding: 10px; align-content: start; }
.wf-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.wf-panel-bar { flex-shrink: 0; padding: 6px 10px; }
.row { height: 32px; border-bottom: 1px solid #eee; }
.cell { height: 90px; }
</style></head><body>
<div class="overlay"><div class="el-dialog">
  <div class="el-dialog__header"><b>工作区文件 · 会话 #2202</b></div>
  <div class="el-dialog__body"><div class="wf-body">
    <div class="wf-breadcrumb">工作区 / root</div>
    <div id="list" class="wf-table-wrap">
      ${'<div class="row">row</div>'.repeat(200)}
    </div>
  </div></div>
</div></div>
</body></html>`

test('内容区弹性填满弹窗剩余高度（不再被 vh 常量限低）', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.setContent(HTML)

  const dialog = await page.locator('.el-dialog').boundingBox()
  const body = await page.locator('.el-dialog__body').boundingBox()
  const list = await page.locator('#list').boundingBox()

  // 弹窗按 92vh 上限：900 * 0.92 = 828（top 4vh = 36，总占用 864 < 900，不溢出视口）
  expect(dialog!.height).toBeGreaterThan(800)
  expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(900)

  // 内容区高度 = body 高度 - 面包屑 - gap，接近弹窗全部可用空间（而不是 ~396px 的 44vh）
  expect(list!.height).toBeGreaterThan(700)
  expect(list!.height).toBeLessThanOrEqual(body!.height)

  // 内容超出才滚动：200 行 * 32px 远超可视区，scrollHeight 远大于 clientHeight
  const overflow = await page.locator('#list').evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }))
  expect(overflow.scroll).toBeGreaterThan(overflow.client * 2)

  // 弹窗自身不产生滚动条（内容在内部滚动）
  const dialogScroll = await page.locator('.el-dialog').evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(dialogScroll).toBeLessThanOrEqual(1)
})

test('图标视图同样撑满，且网格列宽不小于 100px', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  // 只替换 HTML 里的容器 class（CSS 两处 class 选择器保持不动，两条视图规则都要生效）
  await page.setContent(HTML
    .replace('<div id="list" class="wf-table-wrap">', '<div id="list" class="wf-grid-wrap">')
    .replaceAll('<div class="row">row</div>', '<div class="cell">cell</div>'))
  const grid = await page.locator('#list').boundingBox()
  expect(grid!.height).toBeGreaterThan(700)

  const cols = await page.locator('#list').evaluate((el) => {
    const width = el.clientWidth - 20 /* padding */
    return Math.floor(width / 104) // minmax(100px,1fr) + gap 4
  })
  expect(cols).toBeGreaterThanOrEqual(9) // 1080px 弹窗至少 9 列
})

test('搜索结果面板（.wf-panel）内部滚动，同样不被限低', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.setContent(HTML
    .replace('id="list" class="wf-table-wrap"', 'class="wf-panel"')
    .replace('<div class="wf-breadcrumb">工作区 / root</div>',
      '<div class="wf-panel-bar">搜索结果</div><div id="list" class="wf-table-wrap">'))

  const panel = await page.locator('.wf-panel').boundingBox()
  const list = await page.locator('#list').boundingBox()
  expect(panel!.height).toBeGreaterThan(700)
  expect(list!.height).toBeGreaterThan(700)
  const panelScroll = await page.locator('.wf-panel').evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(panelScroll).toBeLessThanOrEqual(1)
})
