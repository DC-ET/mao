// Bugcheck：记录详情抽屉的定位包含块（2026-10-23 审查 M-1）。
//
// RunTraceRecordDrawer.vue:184-189：
//   .record-drawer-layer { position: absolute; inset: 0; z-index: 20; }
// 组件注释与技术方案 §5.6 的意图是「覆盖面板内容区，不盖面板外」。
//
// 但 position: absolute 的包含块是**最近的 position != static 的祖先**的 padding box。
// 逐层向上核查抽屉在 DOM 链上的每个祖先的样式，若整条链都没有定位祖先，
// 包含块回落到初始包含块（视口）→ 遮罩铺满整个视口，抽屉右边缘贴屏幕右边。
//
// desktop 的 vitest 是 node 环境、无布局引擎，无法实测 getBoundingClientRect，
// 因此这里按「祖先链样式」静态验证：抽屉祖先链上任一元素带 position != static
// 才满足设计意图。这是 CSS 语义的确定性推论，不是近似。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 取一个 SFC 的 <style scoped> 内容（去掉选择器外的注释不影响本判断）。 */
function styleBlock(file: string): string {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return match?.[1] ?? ''
}

/** 该 class 的规则块里是否声明了 position != static。 */
function isPositioned(style: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(style)) !== null) {
    const body = m[1] ?? ''
    const pos = /position\s*:\s*([a-z]+)/.exec(body)?.[1]
    if (pos != null && pos !== 'static') return true
  }
  return false
}

describe('RunTraceRecordDrawer 定位包含块', () => {
  it('M-1：抽屉自身是 absolute，但祖先链上没有任何定位祖先', () => {
    const drawerStyle = styleBlock('RunTraceRecordDrawer.vue')
    // 抽屉层确实是 absolute（设计意图：覆盖所在容器）
    expect(isPositioned(drawerStyle, '.record-drawer-layer')).toBe(true)

    // 祖先链：run-trace-panel → center-tab-container → task-container → task-layout
    const ancestors: Array<{ file: string; selector: string }> = [
      { file: 'RunTracePanel.vue', selector: '.run-trace-panel' },
      { file: 'CenterTabContainer.vue', selector: '.center-tab-container' },
      { file: '../../views/task/TaskView.vue', selector: '.task-container' },
      { file: '../../views/task/TaskView.vue', selector: '.task-layout' },
    ]
    const positioned: string[] = []
    for (const ancestor of ancestors) {
      const source = readFileSync(new URL(`./${ancestor.file}`, import.meta.url), 'utf8')
      const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''
      if (isPositioned(style, ancestor.selector)) positioned.push(ancestor.selector)
    }
    // 期望：至少有一个定位祖先（面板自身 position: relative 即可，最贴合设计意图）
    // 实际：空 —— 包含块回落到初始包含块（视口）
    expect(positioned.length).toBeGreaterThan(0)
  })
})
