import { test, expect, type Page } from '@playwright/test'

async function setup(page: Page) {
  const agents = [
    { id: 1, name: '默认助手', description: '默认', isDefault: true, enabled: true },
    { id: 2, name: '代码助手', description: '写代码', isDefault: false, enabled: true },
    { id: 3, name: '旧助手', description: '已下线', isDefault: false, enabled: false },
  ]
  const writes: { method: string; path: string; payload: unknown }[] = []
  let listUrl = ''
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/admin/login') || path.endsWith('/auth/login')) {
      data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    } else if (path.endsWith('/users/me')) {
      data = { id: 1, username: 'admin', displayName: '管理员', isAdmin: true, permissions: ['agent:read', 'agent:write'] }
    } else if (path.endsWith('/agents/2/enabled') && request.method() === 'PATCH') {
      const payload = request.postDataJSON()
      writes.push({ method: 'PATCH', path, payload })
      const target = agents.find(agent => agent.id === 2)
      if (target) target.enabled = payload.enabled
      data = target
    } else if (path.endsWith('/agents') && request.method() === 'GET') {
      listUrl = request.url()
      data = agents.map(agent => ({ ...agent }))
    }
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/)
  await page.goto('/admin/agents')
  await expect(page.getByRole('button', { name: '创建 Agent' })).toBeVisible()
  return {
    writes,
    listUrl: () => listUrl,
  }
}

test('admin can disable an agent and filter by status', async ({ page }) => {
  const state = await setup(page)
  expect(state.listUrl()).toContain('includeDisabled=true')

  const table = page.locator('.el-table__body')
  await expect(table.getByText('默认助手', { exact: true })).toBeVisible()
  await expect(table.getByText('代码助手', { exact: true })).toBeVisible()
  await expect(table.getByText('旧助手', { exact: true })).toBeVisible()
  await expect(table.locator('tr', { hasText: '默认助手' }).getByRole('button', { name: '停用', exact: true })).toBeDisabled()
  await expect(table.locator('tr', { hasText: '旧助手' }).getByRole('button', { name: '启用', exact: true })).toBeEnabled()

  await table.locator('tr', { hasText: '代码助手' }).getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('button', { name: '确定' }).click()
  await expect(page.getByText('停用成功')).toBeVisible()
  expect(state.writes).toEqual([{
    method: 'PATCH',
    path: '/api/v1/agents/2/enabled',
    payload: { enabled: false },
  }])
  await expect(table.locator('tr', { hasText: '代码助手' }).getByText('停用', { exact: true })).toBeVisible()

  await page.locator('.search-form .el-select').click()
  await page.locator('.el-select-dropdown:visible').getByText('停用', { exact: true }).click()
  await expect(table.getByText('代码助手', { exact: true })).toBeVisible()
  await expect(table.getByText('旧助手', { exact: true })).toBeVisible()
  await expect(table.getByText('默认助手', { exact: true })).toHaveCount(0)
})
