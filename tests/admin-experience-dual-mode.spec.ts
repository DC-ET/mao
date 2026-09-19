import { test, expect, type Locator, type Page, type Request } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

async function setup(page: Page) {
  const writes: { method: string; path: string; payload: Record<string, unknown> }[] = []
  let agent = {
    id: 9, name: '双形态 Agent', description: 'desc', systemPrompt: '角色',
    avatarUrl: null as string | null,
    skillNames: [] as string[], mcpServerIds: [] as number[],
    experiences: [
      { id: 21, content: '第一条启用经验', sortOrder: 0, enabled: true },
      { id: 22, content: '第二条停用经验', sortOrder: 1, enabled: false },
    ],
    suggestedQuestions: [] as unknown[],
    isDefault: 0, defaultModelId: null,
  }
  await page.route('**/uploads/*.png', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/admin/login')) data = { accessToken: 't', refreshToken: 'r' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: '管理员', isAdmin: true, permissions: ['agent:read', 'agent:write'] }
    else if (/\/agents(?:\/9)?$/.test(path) && ['POST', 'PUT'].includes(request.method())) {
      const payload = request.postDataJSON()
      writes.push({ method: request.method(), path, payload })
      agent = { ...agent, ...payload }
      data = agent
    } else if (path.endsWith('/agents')) data = [agent]
    else if (path.endsWith('/agents/9')) data = agent
    else if (path.endsWith('/skill-docs')) data = []
    else if (path.endsWith('/mcp-servers/enabled')) data = []
    else if (path.endsWith('/models/active')) data = []
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.getByPlaceholder('用户名', { exact: true }).fill('admin')
  await page.getByPlaceholder('密码', { exact: true }).fill('admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/)
  await page.goto('/admin/agents')
  await expect(page.getByText('双形态 Agent', { exact: true })).toBeVisible()
  return { writes }
}

async function openExperienceTab(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '编辑', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true })
  await expect(dialog).toBeVisible()
  const tab = dialog.getByRole('tab', { name: '最佳实践', exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return dialog
}

async function switchView(dialog: Locator, label: '表格' | '文本') {
  await dialog.locator('.experience-toolbar .el-segmented__item', { hasText: label }).click()
}

test('table view shows dense rows with switch status and drag handle', async ({ page }) => {
  await setup(page)
  const dialog = await openExperienceTab(page)
  await expect(dialog.getByPlaceholder('请输入经验正文（最长 300 字）')).toHaveCount(2)
  await expect(dialog.getByPlaceholder('请输入经验正文（最长 300 字）').first()).toHaveValue('第一条启用经验')
  const switches = dialog.locator('.experience-panel .el-switch')
  await expect(switches).toHaveCount(2)
  await expect(switches.nth(0)).toHaveClass(/is-checked/)
  await expect(switches.nth(1)).not.toHaveClass(/is-checked/)
  await expect(dialog.locator('.drag-handle')).toHaveCount(2)
  await expect(dialog.getByRole('button', { name: /上移|下移/ })).toHaveCount(0)

  await switches.nth(0).click()
  await expect(switches.nth(0)).not.toHaveClass(/is-checked/)
  await switches.nth(0).click()
  await expect(switches.nth(0)).toHaveClass(/is-checked/)
})

test('text view encodes disabled lines with # and round-trips on switch back', async ({ page }) => {
  await setup(page)
  const dialog = await openExperienceTab(page)
  await switchView(dialog, '文本')
  const textarea = dialog.locator('.experience-textarea textarea')
  await expect(textarea).toHaveValue('第一条启用经验\n# 第二条停用经验')

  await textarea.fill('新启用经验\n# 新停用经验\n\n第三条')
  await switchView(dialog, '表格')
  const inputs = dialog.getByPlaceholder('请输入经验正文（最长 300 字）')
  await expect(inputs).toHaveCount(3)
  await expect(inputs.nth(0)).toHaveValue('新启用经验')
  await expect(inputs.nth(1)).toHaveValue('新停用经验')
  await expect(inputs.nth(2)).toHaveValue('第三条')
  const switches = dialog.locator('.experience-panel .el-switch')
  await expect(switches.nth(1)).not.toHaveClass(/is-checked/)
  await expect(switches.nth(2)).toHaveClass(/is-checked/)

  // 文本模式逐行斑马跳色：启用行按奇偶交替、停用行警示色、空行不着色
  await switchView(dialog, '文本')
  await dialog.locator('.experience-textarea textarea').fill('第一条\n第二条\n# 停用行\n\n第三条')
  const lines = dialog.locator('.experience-text-line')
  await expect(lines).toHaveCount(5)
  await expect(lines.nth(0)).toHaveClass(/active/)
  await expect(lines.nth(0)).not.toHaveClass(/stripe/)
  await expect(lines.nth(1)).toHaveClass(/active/)
  await expect(lines.nth(1)).toHaveClass(/stripe/)
  await expect(lines.nth(2)).toHaveClass(/disabled/)
  await expect(lines.nth(3)).toHaveClass(/empty/)
  await expect(lines.nth(4)).toHaveClass(/active/)
  await expect(lines.nth(4)).not.toHaveClass(/stripe/)
  const bg0 = await lines.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)
  const bg1 = await lines.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)
  const bg2 = await lines.nth(2).evaluate((el) => getComputedStyle(el).backgroundColor)
  const bgBlank = await dialog.locator('.experience-text-backdrop')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  // 相邻启用行底色交替（斑马），停用行与空白底各不相同
  expect(bg0).not.toBe(bg1)
  expect(bg1).not.toBe(bg2)
  expect(bg0).toBe(bgBlank)
})

test('invalid text lines block switching back and empty save from text is rejected', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openExperienceTab(page)
  await switchView(dialog, '文本')
  const textarea = dialog.locator('.experience-textarea textarea')

  await textarea.fill('x'.repeat(301))
  await switchView(dialog, '表格')
  await expect(page.getByText(/第 1 行：超过 300 字/)).toBeVisible()
  await expect(dialog.locator('.experience-textarea textarea')).toBeVisible()

  await textarea.fill('#')
  await switchView(dialog, '表格')
  await expect(page.getByText('第 1 行：内容为空', { exact: true })).toBeVisible()

  await textarea.fill('')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0].payload).toMatchObject({
    experiences: [],
  })
})

test('saving from text view parses content without requiring a switch back', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openExperienceTab(page)
  await switchView(dialog, '文本')
  await dialog.locator('.experience-textarea textarea').fill('批量一\n# 批量二')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0].payload).toMatchObject({
    experiences: [
      { id: 21, content: '批量一', sortOrder: 0, enabled: true },
      { id: 22, content: '批量二', sortOrder: 1, enabled: false },
    ],
  })
})
