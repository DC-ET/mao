import { expect, test, type Page } from '@playwright/test'

/**
 * 模型「客户端可选」（技术方案 2026-11-24）：
 * 列表标出「仅管理端」，编辑弹窗开关可切换并随 PUT 提交 clientVisible；默认模型的开关禁用。
 */

const MODELS = [
  {
    id: 1,
    name: 'Chat 主力',
    provider: 'openai',
    apiProtocol: 'openai-compatible',
    effort: '',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-demo',
    modelId: 'gpt-x',
    modelType: 'text',
    clientImpersonation: 'none',
    authType: 'api_key',
    contextWindowTokens: 128000,
    supportsVision: true,
    isDefault: true,
    status: 1,
    clientVisible: true,
  },
  {
    id: 2,
    name: '客服专用',
    provider: 'openai',
    apiProtocol: 'openai-compatible',
    effort: '',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-demo',
    modelId: 'gpt-embed',
    modelType: 'text',
    clientImpersonation: 'none',
    authType: 'api_key',
    contextWindowTokens: 128000,
    supportsVision: false,
    isDefault: false,
    status: 1,
    clientVisible: false,
  },
]

async function setup(page: Page) {
  const writes: { method: string; path: string; payload: unknown }[] = []
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    let data: unknown = []

    if (path.endsWith('/auth/admin/login') || path.endsWith('/auth/login')) {
      data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    } else if (path.endsWith('/users/me')) {
      data = {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        isAdmin: true,
        permissions: ['analytics:read', 'model:read', 'model:write'],
      }
    } else if (path.endsWith('/models/providers')) {
      data = ['openai']
    } else if (path.endsWith('/models/ecp-availability')) {
      data = { enabled: false }
    } else if (path.endsWith('/models') && request.method() === 'GET') {
      const clientVisible = url.searchParams.get('clientVisible')
      const records = clientVisible == null
        ? MODELS
        : MODELS.filter(m => String(m.clientVisible ? 1 : 0) === clientVisible)
      data = { records: records.map(m => ({ ...m })), total: records.length, page: 1, size: 10 }
    } else if (/\/models\/\d+$/.test(path) && request.method() === 'GET') {
      const id = Number(path.split('/').pop())
      data = { ...(MODELS.find(m => m.id === id) ?? MODELS[0]) }
    } else if (/\/models\/\d+$/.test(path) && request.method() === 'PUT') {
      const id = Number(path.split('/').pop())
      const payload = request.postDataJSON()
      writes.push({ method: 'PUT', path, payload })
      data = { ...(MODELS.find(m => m.id === id) ?? MODELS[0]), ...payload }
    }

    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })

  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/)
  await page.goto('/admin/models')
  await expect(page.getByRole('button', { name: '添加模型' })).toBeVisible()
  return { writes }
}

function clientVisibleSwitch(page: Page) {
  return page.locator('.el-dialog .el-form-item', { hasText: '客户端可选' }).locator('.el-switch')
}

test('lists hidden models with a 仅管理端 tag', async ({ page }) => {
  await setup(page)

  const table = page.locator('.el-table__body')
  await expect(table.locator('tr', { hasText: 'Chat 主力' })).not.toContainText('仅管理端')
  await expect(table.locator('tr', { hasText: '客服专用' })).toContainText('仅管理端')
})

test('toggles client visibility on and submits it with the model', async ({ page }) => {
  const state = await setup(page)

  await page.locator('.el-table__body tr', { hasText: '客服专用' }).getByRole('button', { name: '编辑', exact: true }).click()
  const toggle = clientVisibleSwitch(page)
  await expect(toggle).toBeVisible()
  // 已经是「仅管理端」：开关关闭且可用（非默认模型）
  await expect(toggle).not.toHaveClass(/is-checked/)
  await expect(toggle).not.toHaveClass(/is-disabled/)

  await toggle.click()
  await expect(toggle).toHaveClass(/is-checked/)
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].method).toBe('PUT')
  expect(state.writes[0].path).toBe('/api/v1/models/2')
  expect(state.writes[0].payload).toMatchObject({ clientVisible: true })
})

test('enabling default model auto-turns client visibility back on', async ({ page }) => {
  await setup(page)

  await page.locator('.el-table__body tr', { hasText: '客服专用' }).getByRole('button', { name: '编辑', exact: true }).click()
  const toggle = clientVisibleSwitch(page)
  await expect(toggle).not.toHaveClass(/is-checked/)

  // 「客户端可选」的说明里也含「默认模型」字样，按 label 精确匹配「默认模型」那一项
  const defaultSwitch = page
    .locator('.el-dialog .el-form-item')
    .filter({ has: page.locator('.el-form-item__label', { hasText: /^默认模型$/ }) })
    .locator('.el-switch')
  await defaultSwitch.click()

  await expect(toggle).toHaveClass(/is-checked/)
  await expect(toggle).toHaveClass(/is-disabled/)
})

test('disables the switch for the default model', async ({ page }) => {
  await setup(page)

  await page.locator('.el-table__body tr', { hasText: 'Chat 主力' }).getByRole('button', { name: '编辑', exact: true }).click()
  const toggle = clientVisibleSwitch(page)
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveClass(/is-disabled/)
})
