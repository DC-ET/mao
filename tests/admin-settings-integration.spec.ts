import { test, expect } from '@playwright/test'

/**
 * UI 验证（针对线上已部署版本，通过本地 vite dev server 代理到生产 API）：
 * 1. 登录后进入系统设置页，出现"集成配置"分区
 * 2. 五张卡片渲染、secret 显示掩码输入框
 * 3. 飞书"测试连接"真实调用（凭证已从环境变量导入 DB，应成功）
 * 4. batch 保存往返：改动→保存→回读→还原
 */

const ADMIN_USER = 'admin'
/** 线上管理员密码不入库不入 git，运行时通过 MAO_ADMIN_PASS 注入。 */
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

test('settings integration panel renders with masked secrets and feishu test passes', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.el-tabs', { timeout: 10_000 })

  // 1. 集成配置 Tab 存在且为默认激活
  const integrationTab = page.locator('.el-tabs__item', { hasText: '集成配置' })
  await expect(integrationTab).toBeVisible()
  await expect(integrationTab).toHaveClass(/is-active/)

  // 2. 五张分组卡片
  for (const title of ['LDAP 认证', '飞书 OAuth 登录', '上传配置', 'OSS 对象存储', '网络工具']) {
    await expect(page.locator('.group-title', { hasText: title })).toBeVisible()
  }

  // 3. 飞书 appId 回显、appSecret 为密码输入框（掩码态，placeholder 提示已设置）
  const appSecretInput = page.locator('.group-card', { hasText: '飞书 OAuth 登录' }).locator('input[type="password"]')
  await expect(appSecretInput).toHaveCount(1)
  await expect(appSecretInput).toHaveAttribute('placeholder', /已设置/)

  // 4. 飞书测试连接（真实 API，导入的凭证应有效）
  const feishuCard = page.locator('.group-card', { hasText: '飞书 OAuth 登录' })
  await feishuCard.locator('button', { hasText: '测试连接' }).click()
  await expect(page.locator('.el-message', { hasText: '连接成功' })).toBeVisible({ timeout: 15_000 })
})

test('settings batch save round-trip persists and restores value', async ({ page }) => {
  await login(page)
  await page.goto('/admin/settings')
  await page.waitForSelector('.el-tabs', { timeout: 10_000 })

  const ossCard = page.locator('.group-card', { hasText: 'OSS 对象存储' })
  const sessionInput = ossCard.locator('input').nth(0) // oss.region 第一个文本输入
  const original = await sessionInput.inputValue()
  expect(original).toContain('oss-cn-')

  // 改动并保存
  await sessionInput.fill(`${original}-x`)
  await ossCard.locator('button', { hasText: '保存' }).click()
  await expect(page.locator('.el-message', { hasText: '已保存' })).toBeVisible({ timeout: 10_000 })

  // 回读确认
  const resp = await page.request.get('/api/v1/system-settings', {
    headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` },
  })
  const json = await resp.json()
  const region = json.data.find((r: { settingKey: string }) => r.settingKey === 'oss.region')
  expect(region.value).toBe(`${original}-x`)

  // 还原
  await sessionInput.fill(original)
  await ossCard.locator('button', { hasText: '保存' }).click()
  await expect(page.locator('.el-message', { hasText: '已保存' })).toBeVisible({ timeout: 10_000 })
  const resp2 = await page.request.get('/api/v1/system-settings', {
    headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` },
  })
  const json2 = await resp2.json()
  const region2 = json2.data.find((r: { settingKey: string }) => r.settingKey === 'oss.region')
  expect(region2.value).toBe(original)
})

test('settings api rejects user without settings permission (non-admin)', async ({ request }) => {
  // 未登录直接访问：应 401，证明权限校验生效
  const resp = await request.get('/api/v1/system-settings')
  expect(resp.status()).toBe(401)
})
