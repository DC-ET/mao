import { test, expect, type Page } from '@playwright/test'

/**
 * 「我的用量」抽屉移动端布局的度量契约。
 *
 * 曾出现的缺陷（393px 视口实测）：
 * ① 抽屉关闭按钮不可见：el-drawer__header 的 `& > :first-child { flex: 1 }` 让 #header
 *    插槽内容占满头部全宽，把默认关闭按钮挤出屏幕（实测 left=407，视口仅 393 宽）。
 * ② 统计周期区被挤压：「统计周期」四字被 flex 挤成 11.6×70.5 的竖排细条，6 个分段项
 *    加标签加刷新按钮在 355px 里放不下。
 * ③ 饼图图例项粘连：名称与占比之间只用一个半角空格，11px 下几乎看不出间隔。
 * ④ 明细分页条错位：`total, sizes, prev, pager, next` 连排约 451px，右对齐时「共 N 条」
 *    被整体推到内容区左侧之外（实测 left=-78），条数选择器也跟着跑出屏幕。
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

async function setup(page: Page, onRequest?: (url: string) => void, detailTotal = 0) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const url = route.request().url()
    onRequest?.(url)
    const pathname = new URL(url).pathname
    let data: unknown = null
    if (pathname === '/api/v1/llm-calls/me/summary') data = usageSummary()
    else if (pathname === '/api/v1/llm-calls/me/trends') data = { range: 'today', granularity: 'hour', buckets: [] }
    else if (pathname === '/api/v1/llm-calls/me') data = { records: [], total: detailTotal, page: 1, size: 10 }
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
      gapHeaderToBody: (() => {
        const body = drawerEl.querySelector('.el-drawer__body') as HTMLElement | null
        return body ? Math.round((body.getBoundingClientRect().top - header.getBoundingClientRect().bottom) * 10) / 10 : null
      })(),
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

  test('统计周期标签不竖排，分段控件在窄屏可横向滚动且不溢出抽屉', async ({ page }) => {
    await setup(page)
    const g = await geometry(page)
    // 修前标签被挤成 11.6×70.5 的竖排细条；现在窄屏直接隐藏（segmented 自说明用途），
    // 保底要求是：要么隐藏，要么必须是横排（宽 > 30 且高 < 30）
    if (g.periodLabel) {
      const isVertical = g.periodLabel.width < 30 && g.periodLabel.height > 30
      expect(isVertical).toBe(false)
    }
    // 9 个周期项内容宽约 431px，393px 手机的抽屉内容区只有 301px：装不下是客观事实，
    // 但不能靠压缩项宽解决（EP 会把文字截成「近 ...」省略号），而是让控件内部横向滚动。
    // 所以这里断言「可滚动」而非「不溢出」，同时控件本身与抽屉都不越出屏幕。
    expect(g.segmentedOverflowX).toBeGreaterThan(0)
    expect(g.segmented!.right).toBeLessThanOrEqual(g.viewportW)
    expect(g.segmented!.left).toBeGreaterThanOrEqual(0)
    // 抽屉整体不横向溢出（控件在容器内滚动，不把抽屉撑宽）
    expect(g.drawerOverflowX).toBeLessThanOrEqual(0)
  })

  test('头部紧凑：不与 Tab 之间留一大块空白', async ({ page }) => {
    await setup(page)
    const g = await geometry(page)
    // 修前 EP 默认 margin-bottom: 32px + 周期行被 flex 挤到第三行，头部高达 132px，
    // 头部与 Tab 之间空出一大块。现在头部应压在 90px 内、间距 16px 内
    expect(g.headerSlot!.height).toBeLessThan(90)
    expect(g.gapHeaderToBody!).toBeLessThanOrEqual(16)
  })

  test('周期控件 9 项都完整显示，无省略号截断', async ({ page }) => {
    await setup(page)
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.usage-drawer .el-segmented__item-label')].map(i => i.textContent ?? ''))
    expect(labels).toEqual(['今日', '昨日', '本周', '上周', '本月', '上月', '近 7 天', '近 30 天', '自定义'])
    expect(labels.some(l => l.includes('…') || l.includes('...'))).toBe(false)
  })

  test('点关闭按钮可收起抽屉', async ({ page }) => {
    await setup(page)
    // el-drawer 关闭按钮 aria-label 为「关闭此对话框」；页面可能有多个抽屉，按可见性取
    const closeBtn = page.getByRole('button', { name: '关闭此对话框' }).filter({ visible: true })
    await expect(closeBtn).toHaveCount(1)
    await closeBtn.click()
    await expect(page.locator('.usage-drawer')).toBeHidden()
  })

  test('选「自定义」出现日期区间选择器，且请求带上起止日', async ({ page }) => {
    const seen: string[] = []
    await setup(page, (url) => seen.push(url))
    // 默认没有日期区间控件
    await expect(page.locator('.period-range')).toHaveCount(0)
    await page.getByText('自定义', { exact: true }).click()
    await expect(page.locator('.period-range')).toBeVisible()
    // 两个输入框都有默认值（今天与 6 天前），不会发出不带日期的 custom 请求
    const values = await page.locator('.period-range input').evaluateAll(
      (els) => els.map((e) => (e as HTMLInputElement).value))
    expect(values).toHaveLength(2)
    expect(values[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(values[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(values[0] <= values[1]).toBe(true)
    // 切到自定义后发出的汇总请求带 range=custom 与 startDate
    const summaryUrls = seen.filter((u) => u.includes('/llm-calls/me/summary'))
    expect(summaryUrls.some((u) => u.includes('range=custom') && u.includes('startDate='))).toBe(true)
    // 选择器仍落在抽屉内容区内，不横向溢出
    const box = await page.locator('.period-range').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(393)
  })
})

/**
 * 明细 Tab 分页的度量契约（393px 视口）。
 * 修前 `total, sizes, prev, pager, next` 连排约 451px，而抽屉内容区只有 321px，
 * 右对齐把「共 N 条」整段推到内容区左侧之外（实测 left=-78），条数选择器跟着跑出屏幕，
 * 用户既看不到总数也点不到条数切换器。
 *
 * 注意 total 必须给大值（此处 21410，对应用户截图里的 2141 页）：total=0 时页码只剩
 * 一页 24px 宽，整条分页只有约 150px，根本不会溢出，缺陷复现不出来。
 */
test.describe('「我的用量」明细 Tab 移动端分页', () => {
  test.use({ viewport: { width: 393, height: 852 } })

  /** 明细数据总量：造出 2141 页，让分页条达到真实宽度（约 451px）。 */
  const DETAIL_TOTAL = 21_410

  /** 打开抽屉并切到明细 Tab，等表格与分页渲染完。 */
  async function openDetail(page: Page) {
    await setup(page, undefined, DETAIL_TOTAL)
    await page.getByRole('tab', { name: '明细' }).click()
    await page.waitForSelector('.usage-detail .el-pagination', { timeout: 10_000 })
    await page.waitForTimeout(300)
  }

  test('分页条各部分都落在抽屉内容区内，条数可读可点', async ({ page }) => {
    await openDetail(page)
    const g = await page.evaluate(() => {
      const r = (el: Element | null) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, width: b.width }
      }
      const body = document.querySelector('.el-drawer__body') as HTMLElement
      const wrap = document.querySelector('.usage-detail .pagination-wrap') as HTMLElement
      const pg = wrap.querySelector('.el-pagination') as HTMLElement
      const sizes = pg.querySelector('.el-pagination__sizes .el-select') as HTMLElement
      const summary = document.querySelector('.usage-detail .pagination-summary') as HTMLElement
      return {
        body: r(body),
        wrap: r(wrap),
        wrapScrollable: wrap.scrollWidth > wrap.clientWidth,
        pg: r(pg),
        // 条数选择器必须完整可见（含展开的箭头）且落在内容区内
        sizes: r(sizes),
        sizesText: sizes?.textContent ?? null,
        summary: r(summary),
        summaryText: summary?.textContent ?? null,
        pager: r(pg.querySelector('.el-pager')),
      }
    })
    const bodyLeft = g.body!.left
    const bodyRight = g.body!.right
    // 条数选择器不越界：修前 left=-78 完全在内容区外
    expect(g.sizes!.left).toBeGreaterThanOrEqual(bodyLeft)
    expect(g.sizes!.right).toBeLessThanOrEqual(bodyRight + 1)
    // 看得见当前条数（EP 默认把值渲染成 placeholder 文本）
    expect(g.sizesText).toContain('条/页')
    // 总数改由汇总行给出，也在内容区内
    expect(g.summaryText).toContain('共')
    expect(g.summary!.left).toBeGreaterThanOrEqual(bodyLeft)
    // 整条分页不溢出抽屉内容区（超宽时容器内部横向滚动，而不是把内容推出屏幕）
    expect(g.pg!.left).toBeGreaterThanOrEqual(bodyLeft - 1)
    expect(g.wrapScrollable ? g.wrap!.left : g.pg!.right).toBeLessThanOrEqual(bodyRight + 1)
  })

  test('条数切换器可展开并选中 100 条/页', async ({ page }) => {
    await openDetail(page)
    const select = page.locator('.usage-detail .el-pagination__sizes .el-select')
    await select.click()
    const option = page.locator('.el-select-dropdown__item', { hasText: '100条/页' }).last()
    await expect(option).toBeVisible()
    await option.click()
    // 选中后输入区回显新条数
    await expect(select).toContainText('100条/页')
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
