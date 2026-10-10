import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 顶栏站内信入口的契约。
 *
 * 历史背景：站内信曾是顶栏铃铛图标 + el-badge 未读红点。按需求改造后，
 * 入口收敛到头像菜单（「站内收件箱」），且**取消未读红点提示**——
 * 未读数只在抽屉内以条目未读标识体现，顶栏与菜单项都不再渲染徽标。
 * 这里锁住这两条：入口不在顶栏、任何位置都没有徽标。
 */

function record() {
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
}

test.describe('站内信入口契约', () => {
  test('顶栏不再有站内信图标，入口只在头像菜单', async ({ page }) => {
    await setup(page, 1)
    // 旧顶栏铃铛（.inbox-bell）已彻底移除
    await expect(page.locator('.inbox-bell')).toHaveCount(0)
    await page.getByRole('button', { name: '用户菜单' }).click()
    await expect(page.getByRole('menuitem', { name: '站内收件箱' })).toBeVisible()
  })

  test('有未读时顶栏与菜单项都不再渲染红点徽标', async ({ page }) => {
    await setup(page, 3)
    // 顶栏整排图标里没有任何 el-badge 内容
    await expect(page.locator('.top-nav .el-badge__content')).toHaveCount(0)
    await page.getByRole('button', { name: '用户菜单' }).click()
    await expect(page.locator('.nav-dropdown .el-badge__content')).toHaveCount(0)
    // 未读标识只在抽屉内的条目上体现
    await page.getByRole('menuitem', { name: '站内收件箱' }).click()
    await expect(page.locator('.inbox-drawer')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.inbox-item.is-unread')).toHaveCount(1, { timeout: 10_000 })
  })
})
