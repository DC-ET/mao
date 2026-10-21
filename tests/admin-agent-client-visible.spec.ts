import { test, expect, type Page } from '@playwright/test'

/**
 * 管理后台 Agent「客户端可见」开关：
 * - 列表用「仅管理端」标记隐藏项；
 * - 编辑表单可关闭并随 PUT 提交；
 * - 默认 Agent 的开关禁用（后端另有兜底校验）。
 */

const AGENTS = [
  { id: 1, name: '默认助手', description: '默认', systemPrompt: 'p', isDefault: true, enabled: true, clientVisible: true },
  { id: 2, name: '代码助手', description: '写代码', systemPrompt: 'p', isDefault: false, enabled: true, clientVisible: false },
]

async function setup(page: Page) {
  const writes: { method: string; path: string; payload: unknown }[] = []
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []

    if (path.endsWith('/auth/admin/login') || path.endsWith('/auth/login')) {
      data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    } else if (path.endsWith('/users/me')) {
      data = {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        isAdmin: true,
        permissions: ['analytics:read', 'agent:read', 'agent:write'],
      }
    } else if (path.endsWith('/agents') && request.method() === 'GET') {
      data = AGENTS.map(agent => ({ ...agent }))
    } else if (/\/agents\/\d+$/.test(path) && request.method() === 'GET') {
      const id = Number(path.split('/').pop())
      data = { ...(AGENTS.find(agent => agent.id === id) ?? AGENTS[0]) }
    } else if (/\/agents\/\d+$/.test(path) && request.method() === 'PUT') {
      const id = Number(path.split('/').pop())
      const payload = request.postDataJSON()
      writes.push({ method: 'PUT', path, payload })
      data = { ...(AGENTS.find(agent => agent.id === id) ?? AGENTS[0]), ...payload }
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
  return { writes }
}

function clientVisibleSwitch(page: Page) {
  return page.locator('.el-dialog .el-form-item', { hasText: '客户端可见' }).locator('.el-switch')
}

test('lists hidden agents with a 仅管理端 tag', async ({ page }) => {
  await setup(page)

  const table = page.locator('.el-table__body')
  await expect(table.locator('tr', { hasText: '默认助手' })).not.toContainText('仅管理端')
  await expect(table.locator('tr', { hasText: '代码助手' })).toContainText('仅管理端')
})

test('toggles client visibility off and submits it with the agent', async ({ page }) => {
  const state = await setup(page)

  await page.locator('.el-table__body tr', { hasText: '代码助手' }).getByRole('button', { name: '编辑', exact: true }).click()
  const toggle = clientVisibleSwitch(page)
  await expect(toggle).toBeVisible()
  // mock 数据里代码助手已是「仅管理端」，开关应为关闭态
  await expect(toggle).not.toHaveClass(/is-checked/)
  await expect(toggle).not.toHaveClass(/is-disabled/)

  await toggle.click()
  await expect(toggle).toHaveClass(/is-checked/)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].method).toBe('PUT')
  expect(state.writes[0].path).toBe('/api/v1/agents/2')
  expect(state.writes[0].payload).toMatchObject({ clientVisible: true })
})

test('disables the switch for the default agent', async ({ page }) => {
  await setup(page)

  await page.locator('.el-table__body tr', { hasText: '默认助手' }).getByRole('button', { name: '编辑', exact: true }).click()
  const toggle = clientVisibleSwitch(page)
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveClass(/is-disabled/)
})
