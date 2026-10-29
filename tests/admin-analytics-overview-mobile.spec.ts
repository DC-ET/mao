import { test, expect, type Page } from '@playwright/test'

/**
 * 「用量分析 · 总览」指标卡在多视口下的布局契约（页面级 mock，只校验渲染几何）。
 *
 * 曾出现的缺陷（390px 视口实测）：指标条固定 3 列，主指标 36px 数值在约 105px 宽的列里
 * 右溢出 15px（360px 时 25px），与右侧相邻卡片里的数字在视觉上粘连；「1.45 万」被折成
 * 「1.45 / 万」两行，环比徽章紧贴数值。修复后按宽度分档：≤960px 三列、≤768px 两列且
 * 主指标独占整行、数值与徽章允许换行。这里锁住几何，避免回归。
 */

const overviewPayload = {
  period: {
    days: 0,
    start: '2026-10-14',
    end: '2026-10-14',
    previousStart: '2026-10-13',
    previousEnd: '2026-10-13'
  },
  overview: { runningSessions: 4, waitingSessions: 0 },
  periodTotals: {
    sessions: 70,
    messages: 14500,
    chatTokens: 918000000,
    backgroundTokens: 1100000,
    totalTokens: 919100000,
    backgroundCalls: 0,
    totalCost: 183.25,
    activeUsers: 25,
    completedSessions: 184,
    failedSessions: 1,
    promptTokens: 918600000,
    cachedTokens: 863100000,
    cacheHitRate: 94
  },
  previousTotals: {
    totalTokens: 735000000,
    sessions: 56,
    messages: 12200,
    activeUsers: 21,
    totalCost: 170.1,
    cacheHitRate: 90.2
  },
  spark: Array.from({ length: 24 }, (_, i) => ({
    date: `2026-10-14T${String(i).padStart(2, '0')}:00:00Z`,
    totalTokens: 20_000_000 + i * 1_500_000
  })),
  phaseDistribution: [
    { phase: 'COMPLETED', count: 184 },
    { phase: 'FAILED', count: 1 },
    { phase: 'CANCELLED', count: 0 }
  ],
  insights: [{ level: 'warn', text: '失败会话 1 个，建议关注失败原因', path: '/sessions?phase=FAILED' }]
}

async function openOverview(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('refreshToken', 'test-refresh')
  })
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = null
    if (path.endsWith('/users/me')) {
      data = {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        email: '',
        avatarUrl: '',
        permissions: ['analytics:read'],
        isAdmin: true
      }
    } else if (path.endsWith('/auth/features')) {
      data = { feishuEnabled: false }
    } else if (path.endsWith('/admin/analytics/overview')) {
      data = overviewPayload
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, message: 'success', data })
    })
  })
  await page.goto('/admin/analytics')
  await page.waitForSelector('.metric-strip .metric')
  await page.waitForTimeout(300)
}

const WIDTHS = [360, 390, 430, 768, 1024]

for (const width of WIDTHS) {
  test(`overview metric strip stays readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openOverview(page)

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)

    const metrics = page.locator('.metric-strip .metric')
    expect(await metrics.count()).toBe(6)

    for (let i = 0; i < 6; i++) {
      const card = metrics.nth(i)
      const label = (await card.locator('.label').innerText()).trim()
      const cardBox = (await card.boundingBox())!
      const value = card.locator('.value')
      const valueBox = (await value.boundingBox())!

      // 数值整体不拆行、不溢出所在卡片；卡片间不互相侵占
      expect(await value.evaluate((el) => el.getClientRects().length), `${label} 数值被折行`).toBe(1)
      expect(
        valueBox.x + valueBox.width - (cardBox.x + cardBox.width),
        `${label} 数值溢出卡片右边界`
      ).toBeLessThanOrEqual(0.5)

      const delta = card.locator('.delta')
      if ((await delta.count()) > 0) {
        const deltaBox = (await delta.boundingBox())!
        const apart =
          valueBox.x + valueBox.width <= deltaBox.x + 0.5 ||
          deltaBox.x + deltaBox.width <= valueBox.x + 0.5 ||
          valueBox.y + valueBox.height <= deltaBox.y + 0.5 ||
          deltaBox.y + deltaBox.height <= valueBox.y + 0.5
        expect(apart, `${label} 数值与环比徽章重叠`).toBe(true)
      }
    }
  })
}

// 自定义周期会在工具栏内联多出两个日期选择器（各 132px），窄屏最容易被撑出横向滚动。
for (const width of [360, 390]) {
  test(`custom period controls fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openOverview(page)

    await page.locator('.period-trigger').click()
    await page.locator('.period-picker-popper .period-custom-entry').click()
    const pickers = page.locator('.toolbar-actions .period-date')
    await expect(pickers).toHaveCount(2)
    await page.waitForTimeout(300)

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    for (let i = 0; i < 2; i++) {
      const box = (await pickers.nth(i).boundingBox())!
      expect(box.x, `第 ${i + 1} 个日期选择器左溢出`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `第 ${i + 1} 个日期选择器右溢出`).toBeLessThanOrEqual(width + 0.5)
    }
  })
}
