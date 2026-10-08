// 回归：分享会话弹窗必须挂到 body，否则会被侧边栏的 fixed 包含块 + overflow:hidden
// 裁成「嵌在侧栏里、显示不全」的样子（el-dialog 的 overlay 是 position:fixed）。
// 同时锁死宽度用视口相对值，避免窄视口（安卓 / 窄窗）下 480px 溢出屏幕。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dialogSrc = readFileSync(new URL('./ShareDialog.vue', import.meta.url), 'utf8')
const dialogOpenTag = dialogSrc.slice(dialogSrc.indexOf('<el-dialog'), dialogSrc.indexOf('>', dialogSrc.indexOf('<el-dialog')))
const panelCss = readFileSync(new URL('./task-index-panel.css', import.meta.url), 'utf8')

describe('ShareDialog 弹窗定位回归', () => {
  it('el-dialog 带 append-to-body', () => {
    expect(dialogOpenTag).toContain('append-to-body')
  })

  it('宽度随视口收缩，不用固定 480px', () => {
    expect(dialogOpenTag).toContain('100vw')
    expect(dialogOpenTag).not.toMatch(/width="480px"/)
  })

  it('侧边栏不创建 fixed 定位包含块', () => {
    const panelDecl = panelCss
      .slice(panelCss.indexOf('.task-index-panel {'), panelCss.indexOf('}', panelCss.indexOf('.task-index-panel {')))
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(panelDecl).not.toContain('backdrop-filter')
    expect(panelDecl).not.toContain('transform')
    expect(panelDecl).not.toContain('filter')
  })
})
