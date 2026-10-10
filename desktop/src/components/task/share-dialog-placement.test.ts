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

  it('撤销确认的按钮与分享弹窗同档，统一走全局 small 度量', () => {
    expect(dialogSrc).toContain("customClass: 'share-revoke-message-box'")
    const css = dialogSrc.slice(dialogSrc.indexOf('.share-revoke-message-box'))
    expect(css).toContain('font-size: 13px')
    // 消息框按钮不再单独写度量，由全局 .el-button（small）接管
    expect(css).not.toMatch(/\.el-message-box__btns \.el-button \{[\s\S]*?(height|padding|font-size)\s*:/)
    // 与分享弹窗自身的按钮共用同一套度量令牌
    expect(dialogSrc).toMatch(/\.share-btn \{[\s\S]*?height: var\(--aw-btn-height\)/)
    expect(dialogSrc).toMatch(/\.share-btn \{[\s\S]*?padding: var\(--aw-btn-padding\)/)
    expect(dialogSrc).toMatch(/\.share-btn \{[\s\S]*?font-size: var\(--aw-text-fine\)/)
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
