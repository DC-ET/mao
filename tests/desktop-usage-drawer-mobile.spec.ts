import { test, expect, type Page } from '@playwright/test'

/**
 * 「我的用量」抽屉移动端布局的度量契约。
 *
 * 三个曾出现的缺陷（393px 视口实测）：
 * ① 抽屉关闭按钮不可见：el-drawer__header 的 `& > :first-child { flex: 1 }` 让 #header
 *    插槽内容占满头部全宽，把默认关闭按钮挤出屏幕（实测 left=407，视口仅 393 宽）。
 * ② 统计周期区被挤压：「统计周期」四字被 flex 挤成 11.6×70.5 的竖排细条，6 个分段项
 *    加标签加刷新按钮在 355px 里放不下。
 * ③ 饼图图例项粘连：名称与占比之间只用一个半角空格，11px 下几乎看不出间隔。
 * 这里锁住修复后的几何，避免回归。
 */

function usageSummary() {
  return {
    range: 'today',
    totals: {
      callCount: 120, successCount: 118, failCount: 2,
      promptTokens: 500000, completionTokens: 250000, cachedTokens: 120000,
      totalTokens: 750000, cost: 12.5,
    },
    byModel: [
      { modelId: 1, modelName: 'step-5 (plan2)', callCount: 118, failCount: 1, promptTokens: 400000, completionTokens: 200000, totalTokens: 600000, cost: 10 },
      { modelId: 2, modelName: 'mimo-v2.6', callCount: 2, failCount: 1, promptTokens: 100000, completionTokens: 50000, totalTokens: 150000, cost: 2.5 },
    ],
    byScene: [
      { scene: 'chat', callCount: 118, failCount: 0, totalTokens: 600000 },
      { scene: 'title', callCount: 2, failCount: 0, totalTokens: 150000 },
    ],
    byAgent: [
      { agentId: 1, agentName: '默认 Agent', callCount: 120, failCount: 2, totalTokens: 750000, cost: 12.5 },
    ],
  }
}

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data: unknown = null
    if (pathname === '/api/v1/llm-calls/me/summary') data = usageSummary()
    else if (pathname === '/api/v1/llm-calls/me/trends') data = { range: 'today', granularity: 'hour', buckets: [] }
    else if (pathname === '/api/v1/llm-calls/me') data = { records: [], total: 0, page: 1, size: 10 }
    else if (pathname === '/api/v1/models/active') data = []
    else if (pathname.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: 'Admin' }
    else if (pathname.endsWith('/auth/features')) data = { feishuEnabled: false }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, message: 'success', data }) })
  })
  await page.goto('/')
  await page.waitForSelector('.top-nav', { timeout: 15_000 })
  await page.locator('.usage-bell').click()
  await page.waitForSelector('.usage-drawer', { timeout: 10_000 })
  // el-drawer 有滑入过渡：动画中间态的 getBoundingClientRect 是偏移值，必须等位置稳定再量
  await waitForSettled(page)
}

/** 等抽屉滑入动画结束：连续两帧 rect 不再变化。 */
async function waitForSettled(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('.usage-drawer') as HTMLElement | null
    if (!el) return false
    const w = window as unknown as { __prev?: number }
    const cur = Math.round(el.getBoundingClientRect().left)
    const stable = w.__prev === cur
    w.__prev = cur
    return stable
  }, undefined, { timeout: 5_000, polling: 100 })
  await page.waitForTimeout(150)
}

/** 抽屉内各关键元素的几何：关闭按钮、头部插槽、周期控件与「统计周期」标签。 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('.usage-drawer') as HTMLElement
    const drawerEl = drawer.closest('.el-drawer') as HTMLElement
    // 关闭按钮是 el-drawer__header 的兄弟节点，不在 .usage-drawer 内部
    const box = (el: HTMLElement | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const header = drawerEl.querySelector('.el-drawer__header') as HTMLElement
    const seg = drawer.querySelector('.drawer-actions .el-segmented') as HTMLElement | null
    // 关闭按钮在 header 之后、可能被 focus-trap 容器包裹；页面上还有收件箱等抽屉，
    // 必须限定在本抽屉的 header 范围内取
    const closeBtnEl = header.parentElement?.querySelector('.el-drawer__close-btn') as HTMLElement | null
      ?? drawerEl.querySelector('.el-drawer__close-btn') as HTMLElement | null
    return {
      viewportW: window.innerWidth,
      closeBtn: box(closeBtnEl),
      headerSlot: box(drawer.querySelector('.drawer-header')),
      periodLabel: box(drawer.querySelector('.period-label')),
      segmented: seg ? (() => { const r = seg.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height } })() : null,
      segmentedOverflowX: seg ? seg.scrollWidth - seg.clientWidth : null,
      headerOverflowX: header.scrollWidth - header.clientWidth,
      drawerOverflowX: drawerEl.scrollWidth - drawerEl.clientWidth,
    }
  })
}

test.describe('「我的用量」抽屉移动端布局', () => {
  test.use({ viewport: { width: 393, height: 852 } })

  test('关闭按钮落在视口内且可点', async ({ page }) => {
    await setup(page)
    const g = await geometry(page)
    // 修前 left=407（视口 393），按钮整体在屏幕外
    expect(g.closeBtn).not.toBeNull()
    expect(g.closeBtn!.left).toBeGreaterThanOrEqual(0)
    expect(g.closeBtn!.right).toBeLessThanOrEqual(g.viewportW)
    expect(g.closeBtn!.width).toBeGreaterThan(20)
    // 头部自身不溢出
    expect(g.headerOverflowX).toBeLessThanOrEqual(0)
  })

  test('统计周期标签横排，6 个分段项完整不裁切', async ({ page }) => {
    await setup(page)
    const g = await geometry(page)
    // 修前标签被挤成 11.6×70.5 的竖排细条
    expect(g.periodLabel!.width).toBeGreaterThan(30)
    expect(g.periodLabel!.height).toBeLessThan(30)
    // 修前 segmented 内容宽 292 却只有 257 容器，最后一项被裁 35px
    expect(g.segmentedOverflowX).toBeLessThanOrEqual(0)
    expect(g.segmented!.right).toBeLessThanOrEqual(g.viewportW)
    // 抽屉整体不横向溢出
    expect(g.drawerOverflowX).toBeLessThanOrEqual(0)
  })

  test('点关闭按钮可收起抽屉', async ({ page }) => {
    await setup(page)
    // el-drawer 关闭按钮 aria-label 为「关闭此对话框」；页面可能有多个抽屉，按可见性取
    const closeBtn = page.getByRole('button', { name: '关闭此对话框' }).filter({ visible: true })
    await expect(closeBtn).toHaveCount(1)
    await closeBtn.click()
    await expect(page.locator('.usage-drawer')).toBeHidden()
  })
})

test.describe('「我的用量」抽屉桌面端布局不回归', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('桌面端头部单行、周期控件不被关闭按钮挤没', async ({ page }) => {
    await setup(page)
    const g = await geometry(page)
    expect(g.closeBtn).not.toBeNull()
    expect(g.closeBtn!.right).toBeLessThanOrEqual(g.viewportW)
    // 桌面端插槽内容不应越过关闭按钮
    expect(g.headerSlot!.right).toBeLessThanOrEqual(g.closeBtn!.left + 1)
    expect(g.headerOverflowX).toBeLessThanOrEqual(0)
  })
})
