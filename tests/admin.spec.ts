import { test, expect } from '@playwright/test'

const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin123'

/** Login helper: navigates to login, fills form, submits, waits for dashboard */
async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await page.waitForSelector('.login-card', { timeout: 10_000 })

  await page.fill('input[placeholder="用户名"]', ADMIN_USER)
  await page.fill('input[placeholder="密码"]', ADMIN_PASS)
  await page.click('button:has-text("登录")')

  // Wait for redirect to dashboard
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 10_000 })
  // Wait for layout to be fully rendered
  await page.waitForSelector('.layout-container', { timeout: 10_000 })
}

// ─────────────────────────────────────────────────────────
// Login Page
// ─────────────────────────────────────────────────────────
test.describe('Login Page', () => {
  test('should render login form', async ({ page }) => {
    await page.goto('/admin/login')
    await expect(page.locator('.login-card h2')).toHaveText('Agent 工作台 - 管理后台')
    await expect(page.locator('input[placeholder="用户名"]')).toBeVisible()
    await expect(page.locator('input[placeholder="密码"]')).toBeVisible()
    await expect(page.locator('button:has-text("登录")')).toBeVisible()
  })

  test('should login successfully and redirect to dashboard', async ({ page }) => {
    await login(page)
    // Should show user info in header
    await expect(page.locator('.username')).toBeVisible()
    // Sidebar should have active menu
    await expect(page.locator('.sidebar-menu .is-active')).toContainText('数据概览')
  })

  test('should show error with wrong credentials', async ({ page }) => {
    await page.goto('/admin/login')
    await page.fill('input[placeholder="用户名"]', 'admin')
    await page.fill('input[placeholder="密码"]', 'wrongpass')
    await page.click('button:has-text("登录")')
    // Element Plus error message appears
    await expect(page.locator('.el-message--error')).toBeVisible({ timeout: 10_000 })
  })

  test('should not submit with empty fields', async ({ page }) => {
    await page.goto('/admin/login')
    await page.click('button:has-text("登录")')
    // Should still be on login page, no redirect
    await expect(page).toHaveURL(/\/login/)
  })
})

// ─────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('should show overview stat cards', async ({ page }) => {
    const statCards = page.locator('.stat-card')
    await expect(statCards.first()).toBeVisible({ timeout: 10_000 })
    // Should have 4 stat cards
    await expect(statCards).toHaveCount(4)
    // Verify stat labels
    await expect(page.locator('.stat-label')).toContainText(['Agent 数量', '用户数量', '总会话数', '总消息数'])
  })

  test('should show stat values as numbers', async ({ page }) => {
    const values = page.locator('.stat-value')
    await expect(values.first()).toBeVisible({ timeout: 10_000 })
    // All values should be non-empty
    const count = await values.count()
    for (let i = 0; i < count; i++) {
      const text = await values.nth(i).textContent()
      expect(text).toMatch(/\d+/)
    }
  })

  test('should show trend chart and rank sections', async ({ page }) => {
    await expect(page.locator('.chart-container')).toBeVisible({ timeout: 10_000 })
    // Usage trend card title
    await expect(page.locator('.el-card:has(.chart-container) .el-card__header')).toContainText('使用趋势')
    // Agent rank card
    await expect(page.locator('.rank-item').first()).toBeVisible({ timeout: 10_000 })
  })

  test('should show token and user stats tables', async ({ page }) => {
    // Token table
    await expect(page.locator('text=Token 消耗排行')).toBeVisible({ timeout: 10_000 })
    // User activity table
    await expect(page.locator('text=用户活跃度')).toBeVisible({ timeout: 10_000 })
    // Tables should have headers
    const tables = page.locator('.el-table')
    const tableCount = await tables.count()
    expect(tableCount).toBeGreaterThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────
// Agent Management
// ─────────────────────────────────────────────────────────
test.describe('Agent Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('span:has-text("Agent 管理")')
    await page.waitForSelector('.agent-list', { timeout: 10_000 })
  })

  test('should display agent list page', async ({ page }) => {
    await expect(page.locator('.card-header span').first()).toContainText('Agent 列表')
    await expect(page.locator('button:has-text("创建 Agent")')).toBeVisible()
  })

  test('should show search input and table', async ({ page }) => {
    await expect(page.locator('input[placeholder="Agent 名称"]')).toBeVisible()
    const table = page.locator('.el-table')
    await expect(table).toBeVisible()
    // Table should have column headers
    await expect(table.locator('thead th')).toContainText(['ID', '名称', '描述', '模型', '标签', '创建时间', '操作'])
  })

  test('should show agent data rows', async ({ page }) => {
    // Wait for data to load
    await page.waitForSelector('.el-table__body tr', { timeout: 15_000 })
    const rows = page.locator('.el-table__body tr')
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('should open create dialog on button click', async ({ page }) => {
    await page.click('button:has-text("创建 Agent")')
    await expect(page.locator('.el-dialog')).toBeVisible()
    await expect(page.locator('.el-dialog__header')).toContainText('创建 Agent')
    // Dialog should have name field
    await expect(page.locator('.el-dialog input[placeholder="请输入 Agent 名称"]')).toBeVisible()
    // Close dialog
    await page.click('.el-dialog button:has-text("取消")')
    await expect(page.locator('.el-dialog')).not.toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────
// Model Management
// ─────────────────────────────────────────────────────────
test.describe('Model Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('span:has-text("模型管理")')
    await page.waitForSelector('.model-list', { timeout: 10_000 })
  })

  test('should display model list page', async ({ page }) => {
    await expect(page.locator('.card-header span').first()).toContainText('模型配置')
    await expect(page.locator('button:has-text("添加模型")')).toBeVisible()
  })

  test('should show model table with data', async ({ page }) => {
    const table = page.locator('.el-table')
    await expect(table).toBeVisible()
    await expect(table.locator('thead th')).toContainText(['ID', '名称', '供应商', '模型标识', 'API 地址', '视觉', '默认', '状态', '操作'])
    // Wait for data rows
    await page.waitForSelector('.el-table__body tr td', { timeout: 15_000 })
    const rows = page.locator('.el-table__body tr')
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('should open add model dialog', async ({ page }) => {
    await page.click('button:has-text("添加模型")')
    await expect(page.locator('.el-dialog')).toBeVisible()
    await expect(page.locator('.el-dialog__header')).toContainText('添加模型')
    await page.click('.el-dialog button:has-text("取消")')
  })
})

// ─────────────────────────────────────────────────────────
// User Management
// ─────────────────────────────────────────────────────────
test.describe('User Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('span:has-text("用户管理")')
    await page.waitForSelector('.user-list', { timeout: 10_000 })
  })

  test('should display user list page', async ({ page }) => {
    await expect(page.locator('.card-header span').first()).toContainText('用户管理')
    await expect(page.locator('button:has-text("新建用户")')).toBeVisible()
  })

  test('should show user table with data', async ({ page }) => {
    await page.waitForSelector('.el-table__body tr', { timeout: 15_000 })
    const rows = page.locator('.el-table__body tr')
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('should show search filters', async ({ page }) => {
    await expect(page.locator('input[placeholder="用户名 / 显示名 / 邮箱"]')).toBeVisible()
    await expect(page.locator('button:has-text("查询")')).toBeVisible()
    await expect(page.locator('button:has-text("重置")')).toBeVisible()
  })

  test('should open create user dialog', async ({ page }) => {
    await page.click('button:has-text("新建用户")')
    await expect(page.locator('.el-dialog')).toBeVisible()
    await expect(page.locator('.el-dialog__header')).toContainText('新建用户')
    await page.click('.el-dialog button:has-text("取消")')
  })
})

// ─────────────────────────────────────────────────────────
// Skills Management
// ─────────────────────────────────────────────────────────
test.describe('Skills Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('span:has-text("Skills 管理")')
    await page.waitForSelector('.skill-list', { timeout: 10_000 })
  })

  test('should display skills page with upload zone', async ({ page }) => {
    await expect(page.locator('.card-header span').first()).toContainText('Agent Skills')
    // Upload zone should be visible
    await expect(page.locator('.upload-zone')).toBeVisible()
    await expect(page.locator('.upload-text')).toContainText(/拖动或点击上传/)
  })

  test('should show skill table', async ({ page }) => {
    const table = page.locator('.el-table')
    await expect(table).toBeVisible()
    await expect(table.locator('thead th')).toContainText(['名称', '描述', '路径', '操作'])
  })
})

// ─────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────
test.describe('Session Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('span:has-text("会话管理")')
    await page.waitForSelector('.session-list', { timeout: 10_000 })
  })

  test('should display session list page', async ({ page }) => {
    await expect(page.locator('.card-header span').first()).toContainText('会话管理')
  })

  test('should show session table with data', async ({ page }) => {
    await page.waitForSelector('.el-table__body tr', { timeout: 15_000 })
    const rows = page.locator('.el-table__body tr')
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(1)
    // Should have session columns
    const headerTexts = await page.locator('.el-table thead th').allTextContents()
    expect(headerTexts.join(' ')).toMatch(/ID|标题|用户|Agent|执行模式|任务阶段/)
  })

  test('should have filter form elements', async ({ page }) => {
    await expect(page.locator('input[placeholder="标题/摘要"]')).toBeVisible()
    await expect(page.locator('button:has-text("查询")')).toBeVisible()
    await expect(page.locator('button:has-text("重置")')).toBeVisible()
  })

  test('should navigate to session detail on click', async ({ page }) => {
    // Wait for data
    await page.waitForSelector('.el-table__body tr', { timeout: 15_000 })
    // Check if there's a "查看" button
    const viewBtn = page.locator('.el-table__body tr:first-child button:has-text("查看")')
    if (await viewBtn.isVisible()) {
      await viewBtn.click()
      // Should navigate to detail page
      await page.waitForURL(/\/admin\/sessions\/\d+/, { timeout: 10_000 })
      await expect(page.locator('.session-detail')).toBeVisible()
      // Should show session info
      await expect(page.locator('.info-card')).toBeVisible({ timeout: 10_000 })
    }
  })
})

// ─────────────────────────────────────────────────────────
// Sidebar Navigation
// ─────────────────────────────────────────────────────────
test.describe('Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('should navigate between all pages via sidebar', async ({ page }) => {
    const navItems = [
      { label: '数据概览', url: /\/dashboard$/ },
      { label: 'Agent 管理', url: /\/agents$/ },
      { label: '模型管理', url: /\/models$/ },
      { label: 'Skills 管理', url: /\/skills$/ },
      { label: '会话管理', url: /\/sessions$/ },
      { label: '用户管理', url: /\/users$/ },
    ]

    for (const item of navItems) {
      await page.click(`span:has-text("${item.label}")`)
      // Wait for route change
      await page.waitForURL(item.url, { timeout: 10_000 })
      // The active menu item indicator should be visible
      await expect(page.locator('.sidebar-menu .is-active')).toContainText(item.label)
    }
  })
})

// ─────────────────────────────────────────────────────────
// Tab Bar
// ─────────────────────────────────────────────────────────
test.describe('Tab Bar', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('should show tabs when navigating between pages', async ({ page }) => {
    // Open a few pages
    await page.click('span:has-text("Agent 管理")')
    await page.waitForURL(/\/agents$/)
    await page.click('span:has-text("模型管理")')
    await page.waitForURL(/\/models$/)

    // Tab bar should have multiple tabs
    const tabs = page.locator('.tab-item')
    const count = await tabs.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('should switch pages by clicking tabs', async ({ page }) => {
    await page.click('span:has-text("Agent 管理")')
    await page.waitForURL(/\/agents$/)

    // Click dashboard tab to go back
    await page.locator('.tab-item:has-text("数据概览")').click()
    await page.waitForURL(/\/dashboard$/)
  })
})

// ─────────────────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────────────────
test.describe('Logout', () => {
  test('should logout and redirect to login page', async ({ page }) => {
    await login(page)

    // Click user dropdown
    await page.click('.user-info')
    // Click logout
    await page.locator('.el-dropdown-menu__item:has-text("退出登录")').click()
    // Should redirect to login
    await page.waitForURL(/\/login/, { timeout: 10_000 })
    await expect(page.locator('.login-card')).toBeVisible()
  })
})
