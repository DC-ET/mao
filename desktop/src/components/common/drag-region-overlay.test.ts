// EP 浮层必须从 Electron 拖拽区里抠掉（-webkit-app-region: no-drag）。
// 背景：.top-nav 整条是 drag 区（仅 .nav-left/.nav-right 自身盒子是 no-drag），
// teleport 到 body 的 .el-overlay/.el-popper 画在拖拽带上方，但拖拽区是几何
// 区域（drag 盒子并集 − no-drag 盒子并集），与绘制层级无关——落在拖拽带里的
// mousedown/mousemove 被系统吞掉，无 hover 无点击。「我的用量」抽屉头部的
// 刷新按钮与统计周期前 7 项曾因此点不动，只有伸进 .nav-right 盒子的
// 「近 30 天/自定义」幸存；0.0.270 的 append-to-body 只解决抽屉被顶栏裁剪，
// 没解决几何重叠。真实 Electron 行为无法单测，这里守住全局 style.css 里的
// 规则本身不被误删（scoped 样式到不了 teleport 出去的浮层，必须放全局）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styleCss = readFileSync(new URL('../../style.css', import.meta.url), 'utf8')

describe('EP 浮层的拖拽区豁免', () => {
  it('style.css 把 .el-overlay/.el-popper 标为 no-drag，浮层内容不被顶栏拖拽区吞点击', () => {
    // 规则块：两个选择器共享同一声明（.el-overlay 覆盖抽屉/对话框遮罩与内容，
    // .el-popper 覆盖下拉、日期面板、气泡等 teleport 浮层）
    const rule = /\.el-overlay\s*,\s*\.el-popper\s*\{[^}]*?-webkit-app-region\s*:\s*no-drag\s*;?[^}]*\}/
    expect(styleCss).toMatch(rule)
  })
})
