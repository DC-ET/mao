import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 顶栏收件箱徽标的度量契约。
 *
 * el-badge 默认度量（18px 高 + 6px 内边距 + 1px 同色描边）会把单个数字撑成
 * 18.7×18 的横向椭圆。这里锁住按图标尺度重定义后的几何：数字 1 必须精确正圆，
 * 且整体不宽于两位数以外的夸张拉伸。
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: 'TASK_COMPLETED',
    title: '任务完成',
    content: null,
    isRead: false,
    readAt: null,
    sessionId: null,
    payload: null,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

async function setup(page: Page, unreadCount: number) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    let data: unknown = null
    if (pathname === '/api/v1/inbox/unread-count') data = { unreadCount }
    else if (pathname === '/api/v1/inbox') data = { records: [record()], total: 1, page: 1, size: 20 }
    else if (pathname === '/api/v1/inbox/preferences') data = {}
    else if (pathname.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: 'Admin' }
    else if (pathname.endsWith('/auth/features')) data = { feishuEnabled: false }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, message: 'success', data }) })
  })
  await page.goto('/')
  await page.waitForSelector('.top-nav', { timeout: 15_000 })
  await expect(page.locator('.inbox-bell .el-badge__content')).toBeVisible({ timeout: 10_000 })
}

test.describe('顶栏收件箱徽标度量', () => {
  test('单个数字是正圆且不超 16px', async ({ page }) => {
    await setup(page, 1)
    const badge = page.locator('.inbox-bell .el-badge__content')
    await expect(badge).toHaveText('1', { timeout: 10_000 })

    const box = await badge.boundingBox()
    expect(box).not.toBeNull()
    const ratio = box!.width / box!.height
    expect(box!.height).toBeCloseTo(16, 1)
    // 修前是 18.69/18 = 1.038（横向椭圆），修后应收敛到 1
    expect(Math.abs(ratio - 1)).toBeLessThan(0.02)
  })

  test('两位数仍紧凑，不横向拉伸', async ({ page }) => {
    await setup(page, 12)
    const badge = page.locator('.inbox-bell .el-badge__content')
    await expect(badge).toHaveText('12', { timeout: 10_000 })
    const box = await badge.boundingBox()
    expect(box!.height).toBeCloseTo(16, 1)
    // 修前 25.36px，padding 收窄后应明显更小
    expect(box!.width).toBeLessThan(21)
  })
})
