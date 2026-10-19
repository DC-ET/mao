/**
 * 真实组件 CSS 与布局模型的契约校验：直接从 WorkspaceFileDialog.vue 抽取
 * <style> 块渲染，断言修复后的关键声明存在、旧的 vh 上限已移除。
 * 不依赖后端，只保证「改的是这套规则」。
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SFC = readFileSync(
  join(process.cwd(), 'admin/src/views/session/components/WorkspaceFileDialog.vue'),
  'utf8',
)

/** 抽取 <style scoped> 内容（scoped 的 data 属性在无组件环境下不影响这几条规则） */
function styleBlock(): string {
  const m = SFC.match(/<style scoped>([\s\S]*?)<\/style>/)
  expect(m, '应存在 <style scoped> 块').toBeTruthy()
  return m![1]
}

test('弹窗与内容区使用弹性高度，不再写死 vh', () => {
  const css = styleBlock()
  // 弹窗上限抬高；内容区不再有 vh 常量
  expect(css).toMatch(/max-height:\s*92vh/)
  expect(css).not.toMatch(/max-height:\s*44vh/)
  expect(css).not.toMatch(/max-height:\s*34vh/)
  // 内容区弹性填充 + 可收缩（flex 子项要能低于内容高度，必须配 min-height:0）
  expect(css).toMatch(/flex:\s*1 1 auto/)
  expect(css).toMatch(/min-height:\s*0/)
  expect(css).toMatch(/overflow:\s*auto/)
  // flex 收缩链完整：dialog body 是 flex 容器，wf-body / wf-panel 有 flex:1
  expect(css).toMatch(/el-dialog__body[^{]*\{[^}]*display:\s*flex/s)
  expect(css).toMatch(/\.wf-body\s*\{[^}]*flex:\s*1/s)
  expect(css).toMatch(/\.wf-panel\s*\{[^}]*flex:\s*1/s)
})

test('模板用双视图包裹内容区，且 table-wrap / grid-wrap 成对出现', () => {
  expect(SFC).toContain('class="wf-grid-wrap"')
  expect(SFC).toContain('class="wf-table-wrap"')
  expect(SFC).toMatch(/viewMode === 'grid'/)
  // 弹窗 top 收紧到 4vh，给垂直高度多让一屏
  expect(SFC).toMatch(/top="4vh"/)
})
