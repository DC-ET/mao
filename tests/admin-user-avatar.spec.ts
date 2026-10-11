import { test, expect, type Page } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpRkAAAAASUVORK5CYII=', 'base64')

/** 两行用户：一行有头像，一行没有，用来同时覆盖渲染与回落。 */
const users = {
  records: [
    { id: 2, username: 'zhangsan', displayName: '张三', email: 'zhangsan@example.com', avatarUrl: '/uploads/zhangsan.png', authSource: 'LOCAL', status: 1, roleNames: ['普通用户'] },
    { id: 3, username: 'lisi', displayName: '李四', email: 'lisi@example.com', avatarUrl: null, authSource: 'FEISHU', status: 1, roleNames: [] },
  ],
  total: 2,
}

async function setup(page: Page) {
  // 头像与 Agent 用例同口径：相对 /uploads/ 路径按当前站点解析，用真实 PNG 回填。
  await page.route('**/uploads/*.png', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/admin/login') || path.endsWith('/auth/login')) data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: '管理员', isAdmin: true, permissions: ['analytics:read', 'user:read'] }
    else if (path.endsWith('/users')) data = users
    // 用户详情抽屉的六个 Tab：全部空数据，避免请求悬挂。
    else if (path.endsWith('/admin/sessions')) data = { records: [], total: 0 }
    else if (path.endsWith('/scheduled-tasks/all')) data = { records: [], total: 0 }
    else if (path.endsWith('/admin/user-commands')) data = []
    else if (path.endsWith('/admin/user-skills')) data = []
    else if (path.endsWith('/git-credentials')) data = []
    else if (path.endsWith('/mcp-servers')) data = []
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/)
}

test.describe('管理后台用户管理头像', () => {
  test.beforeEach(async ({ page }) => { await setup(page) })

  test('桌面列表渲染头像，无头像时回落用户名首字符', async ({ page }) => {
    await page.goto('/admin/users')
    const rows = page.locator('.el-table__body-wrapper .el-table__row')
    await expect(rows).toHaveCount(2)
    // /uploads/ 相对路径必须解析成当前站点下的绝对地址，而不是相对 /admin/ 拼路径
    await expect(rows.nth(0).locator('.user-identity img')).toHaveAttribute('src', /^http:\/\/localhost:5200\/uploads\/zhangsan\.png$/)
    await expect(rows.nth(0).locator('.user-identity img')).toBeVisible()
    await expect(rows.nth(1).locator('.user-identity img')).toHaveCount(0)
    await expect(rows.nth(1).locator('.user-identity .el-avatar')).toHaveText('李')
    await expect(rows.nth(0).getByText('zhangsan', { exact: true })).toBeVisible()
  })

  test('用户详情抽屉展示头像', async ({ page }) => {
    await page.goto('/admin/users')
    await page.getByRole('button', { name: '详情', exact: true }).first().click()
    const drawer = page.getByRole('dialog', { name: '用户详情 - 张三' })
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.user-summary img')).toHaveAttribute('src', /^http:\/\/localhost:5200\/uploads\/zhangsan\.png$/)
    await expect(drawer.locator('.user-summary img')).toBeVisible()
  })

  test('移动端卡片渲染头像，无头像时回落', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/admin/users')
    const cards = page.locator('.mobile-card-list .user-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0).locator('.user-card-head img')).toHaveAttribute('src', /^http:\/\/localhost:5200\/uploads\/zhangsan\.png$/)
    await expect(cards.nth(0).locator('.user-card-head img')).toBeVisible()
    await expect(cards.nth(1).locator('.user-card-head img')).toHaveCount(0)
    await expect(cards.nth(1).locator('.user-card-head .el-avatar')).toHaveText('李')
  })
})
