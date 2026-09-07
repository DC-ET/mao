import { test, expect, type Page } from '@playwright/test'

async function setup(page: Page, canWrite = true) {
  let rollbackCount = 0
  let failHistory = false
  const agent = { id: 7, name: '版本测试 Agent', systemPrompt: '新提示词', description: '保持不变' }
  const versions: { id: number; agentId: number; version: number; systemPrompt: string; operatorId: number; sourceVersion: number | null; createdAt: string }[] = [
    { id: 2, agentId: 7, version: 2, systemPrompt: '新提示词', operatorId: 1, sourceVersion: null, createdAt: '2026-09-07 12:00:00' },
    { id: 1, agentId: 7, version: 1, systemPrompt: '原始提示词 <script>alert(1)</script>', operatorId: 1, sourceVersion: null, createdAt: '2026-09-07 11:00:00' },
  ]
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/login')) data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: '管理员', permissions: canWrite ? ['agent:read', 'agent:write'] : ['agent:read'] }
    else if (path.endsWith('/prompt-versions/1/rollback')) {
      rollbackCount++
      agent.systemPrompt = versions[versions.length - 1].systemPrompt
      versions.unshift({ ...versions[versions.length - 1], id: 3, version: 3, sourceVersion: 1 })
      data = agent
    } else if (path.endsWith('/prompt-versions')) {
      if (failHistory) {
        await route.fulfill({ json: { code: 500, message: '历史读取失败', data: null } })
        return
      }
      data = versions
    } else if (path.endsWith('/agents')) data = [agent]
    else if (path.endsWith('/agents/7')) data = agent
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/dashboard/)
  await page.goto('/admin/agents')
  return { rollbackCount: () => rollbackCount, failHistory: (value: boolean) => { failHistory = value } }
}

test('prompt history previews safely and confirms rollback while retaining versions', async ({ page }) => {
  const state = await setup(page)
  await page.getByRole('button', { name: '提示词版本', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '版本测试 Agent · 系统提示词版本', exact: true })
  await expect(dialog.getByRole('textbox')).toHaveValue('新提示词')
  await expect(dialog.getByRole('button', { name: '回滚到此版本' })).toBeDisabled()
  await dialog.getByRole('button', { name: '预览', exact: true }).nth(1).click()
  await expect(dialog.getByRole('textbox')).toHaveValue('原始提示词 <script>alert(1)</script>')
  await dialog.getByRole('button', { name: '回滚到此版本' }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(state.rollbackCount()).toBe(0)
  await dialog.getByRole('button', { name: '回滚到此版本' }).click()
  await page.getByRole('button', { name: '确认回滚', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '预览', exact: true })).toHaveCount(3)
  await expect(dialog).toContainText('回滚自 v1')
  await expect(dialog.getByRole('textbox')).toHaveValue('原始提示词 <script>alert(1)</script>')
  expect(state.rollbackCount()).toBe(1)
})

test('prompt history load failure can be retried', async ({ page }) => {
  const state = await setup(page)
  state.failHistory(true)
  await page.getByRole('button', { name: '提示词版本', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '版本测试 Agent · 系统提示词版本', exact: true })
  await expect(dialog).toContainText('加载失败，请重试')
  await expect(dialog.getByRole('button', { name: '回滚到此版本' })).toBeDisabled()
  state.failHistory(false)
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(dialog.getByRole('textbox')).toHaveValue('新提示词')
})

test('read-only users cannot access prompt history actions', async ({ page }) => {
  await setup(page, false)
  await expect(page.getByText('版本测试 Agent', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '提示词版本', exact: true })).toHaveCount(0)
})
