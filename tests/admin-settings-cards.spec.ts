import { test, expect } from '@playwright/test'

/**
 * 系统设置页卡片化改版 UI 验证（经本地 vite 代理指向后端）：
 * 1. 普通分类渲染为卡片表单（与集成配置面板同风格）
 * 2. 按卡片批量保存往返：改动→保存→API 回读→还原→回读
 * 3. 运行环境分类：只读字段纯展示 + runtime.mode 可编辑（带保存按钮）
 * 线上管理员密码通过 MAO_ADMIN_PASS 注入，不入库不入 git。
 */

const ADMIN_USER = 'admin'
const ADMIN_PASS = process.env.MAO_ADMIN_PASS ?? ''

async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await page.waitForSelector('.login-card', { timeout: 10_000 })
  await page.fill('input[placeholder="用户名"]', ADMIN_USER)
  await page.fill('input[placeholder="密码"]', ADMIN_PASS)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/, { timeout: 10_000 })
  await page.waitForSelector('.layout-container', { timeout: 10_000 })
}

test('plain categories render as card forms', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.settings-layout', { timeout: 10_000 })

  for (const title of ['代码', '审计', '微信', '运行环境']) {
    await expect(page.locator('.group-title', { hasText: title }).first()).toBeVisible()
  }
  await expect(page.locator('[id="setting-cat-会话"] .group-title')).toBeVisible()

  // 模型选择卡：代码/会话分类用下拉，初始带值
  const codeCard = page.locator('.group-card', { hasText: '代码' })
  await expect(codeCard.locator('.el-select')).toHaveCount(1)

  // 运行环境：workspace.root/skills.dir 只读展示，runtime.mode 可编辑（V160 起带保存按钮）
  const envCard = page.locator('.group-card', { hasText: '运行环境' })
  await expect(envCard.locator('button', { hasText: '保存' })).toHaveCount(1)
  await expect(envCard.locator('.field-readonly')).toHaveCount(2)
  await expect(envCard.locator('.el-select')).toHaveCount(1)
})

test('container manage panel exposes auto upgrade switch and build columns', async ({ page }) => {
  // V178：容器管理面板新增自动升级总开关 + 代码/后台版本列（列表数据依赖运行环境，这里只断言结构）
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.settings-layout', { timeout: 10_000 })

  const card = page.locator('#setting-group-container-rebuild')
  await card.scrollIntoViewIfNeeded()
  await expect(card.locator('.switch-label')).toContainText('自动重启空闲容器')
  await expect(card.locator('.el-table__header th', { hasText: '代码版本' })).toHaveCount(1)
  await expect(card.locator('.el-table__header th', { hasText: '后台版本' })).toHaveCount(1)
})

/** 等 batch 接口返回后再断言，避免上一条「已保存」提示还在时回读赶在落库之前。 */
async function saveCard(page: import('@playwright/test').Page, card: import('@playwright/test').Locator) {
  const saved = page.waitForResponse(
    (resp) => resp.url().includes('/system-settings/batch') && resp.request().method() === 'PUT',
  )
  await card.locator('button', { hasText: '保存' }).click()
  const response = await saved
  expect(response.ok()).toBeTruthy()
  await expect(page.locator('.el-message', { hasText: '已保存' }).first()).toBeVisible({ timeout: 10_000 })
}

test('category card batch save round-trip', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.settings-layout', { timeout: 10_000 })

  const uiCard = page.locator('.group-card', { hasText: '审计' })
  const input = uiCard.locator('input').first()
  const original = await input.inputValue()
  expect(Number(original)).toBeGreaterThan(0)

  await input.fill('365')
  await saveCard(page, uiCard)

  const token = await page.evaluate(() => localStorage.getItem('token'))
  const read = async () => {
    const resp = await page.request.get('/api/v1/system-settings', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await resp.json()
    return json.data.find((r: { settingKey: string }) => r.settingKey === 'audit.retentionDays').value
  }
  expect(await read()).toBe('365')

  await input.fill(original)
  await saveCard(page, uiCard)
  expect(await read()).toBe(original)
})
