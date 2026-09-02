import { test, expect } from '@playwright/test'

/**
 * 系统设置页卡片化改版 UI 验证（经本地 vite 代理指向后端）：
 * 1. 普通分类渲染为卡片表单（与集成配置面板同风格）
 * 2. 按卡片批量保存往返：改动→保存→API 回读→还原→回读
 * 3. 只读分类（运行环境）无保存按钮、纯展示
 * 线上管理员密码通过 MAO_ADMIN_PASS 注入，不入库不入 git。
 */

const ADMIN_USER = 'admin'
const ADMIN_PASS = process.env.MAO_ADMIN_PASS ?? ''

async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await page.waitForSelector('.login-card', { timeout: 10_000 })
  await page.fill('input[placeholder="用户名"]', ADMIN_USER)
  await page.fill('input[placeholder="密码"]', ADMIN_PASS)
  await page.click('button:has-text("登录")')
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 10_000 })
  await page.waitForSelector('.layout-container', { timeout: 10_000 })
}

test('plain categories render as card forms', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.settings-layout', { timeout: 10_000 })

  for (const title of ['代码', '会话', '审计', '微信', '运行环境']) {
    await expect(page.locator('.group-title', { hasText: title })).toBeVisible()
  }

  // 模型选择卡：代码/会话分类用下拉，初始带值
  const codeCard = page.locator('.group-card', { hasText: '代码' })
  await expect(codeCard.locator('.el-select')).toHaveCount(1)

  // 只读分类：无保存按钮，纯文本展示
  const envCard = page.locator('.group-card', { hasText: '运行环境' })
  await expect(envCard.locator('button', { hasText: '保存' })).toHaveCount(0)
  await expect(envCard.locator('.field-readonly')).toHaveCount(2)
})

test('category card batch save round-trip', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.settings-layout', { timeout: 10_000 })

  const uiCard = page.locator('.group-card', { hasText: '审计' })
  const input = uiCard.locator('input').first()
  const original = await input.inputValue()
  expect(Number(original)).toBeGreaterThan(0)

  await input.fill('365')
  await uiCard.locator('button', { hasText: '保存' }).click()
  await expect(page.locator('.el-message', { hasText: '已保存' })).toBeVisible({ timeout: 10_000 })

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
  await uiCard.locator('button', { hasText: '保存' }).click()
  await expect(page.locator('.el-message', { hasText: '已保存' })).toBeVisible({ timeout: 10_000 })
  expect(await read()).toBe(original)
})
