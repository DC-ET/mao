import { test, expect, type Locator, type Page, type Request } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const tabs = ['基本信息', '角色提示词', '最佳实践', '工具能力', '运行设置']
const promptPlaceholder = '请输入角色定义：身份、目标、工作内容、表达方式等'

async function setup(page: Page) {
  let agent = {
    id: 7, name: '头像测试 Agent', description: '原始描述', systemPrompt: '原始角色定义',
    avatarUrl: '/uploads/original.png' as string | null,
    skillNames: [] as string[], mcpServerIds: [] as number[], experiences: [],
    isDefault: 1, defaultModelId: 11,
  }
  const writes: { method: string; path: string; payload: Record<string, unknown> }[] = []
  const uploads: Request[] = []
  await page.route('**/uploads/*.png', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/login')) data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', displayName: '管理员', permissions: ['agent:read', 'agent:write'] }
    else if (path.endsWith('/agents/avatar') && request.method() === 'POST') {
      uploads.push(request)
      data = { avatarUrl: '/uploads/uuid.png' }
    } else if (/\/agents(?:\/7)?$/.test(path) && ['POST', 'PUT'].includes(request.method())) {
      const payload = request.postDataJSON()
      writes.push({ method: request.method(), path, payload })
      agent = { ...agent, ...payload }
      data = agent
    } else if (path.endsWith('/agents')) data = [agent]
    else if (path.endsWith('/agents/7')) data = agent
    else if (path.endsWith('/skill-docs')) data = [{ name: 'mock-skill' }]
    else if (path.endsWith('/mcp-servers/enabled')) data = [{ id: 21, name: 'mock-mcp', serverType: 'HTTP' }]
    else if (path.endsWith('/models/active')) data = [{ id: 11, name: 'mock-model' }]
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.getByPlaceholder('用户名', { exact: true }).fill('admin')
  await page.getByPlaceholder('密码', { exact: true }).fill('admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/dashboard/)
  await page.goto('/admin/agents')
  await expect(page.getByText('头像测试 Agent', { exact: true })).toBeVisible()
  return { writes, uploads }
}

async function openDialog(page: Page, mode: '创建' | '编辑' | '复制') {
  await page.getByRole('button', { name: mode === '创建' ? '创建 Agent' : mode, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${mode} Agent`, exact: true })
  await expect(dialog).toBeVisible()
  // Wait for the dialog's initial values before interacting with edit/copy forms.
  if (mode !== '创建') await expect(dialog.getByPlaceholder('请输入 Agent 名称', { exact: true })).toHaveValue(mode === '复制' ? '头像测试 Agent - 副本' : '头像测试 Agent')
  return dialog
}

async function selectTab(dialog: Locator, name: string) {
  const tab = dialog.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tabpanel', { name, exact: true })).toBeVisible()
}

async function chooseOption(page: Page, dialog: Locator, label: string, option: string) {
  await dialog.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: label }) }).locator('.el-select__wrapper').click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await page.keyboard.press('Escape')
}

test('all five tabs preserve values and save the complete payload', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openDialog(page, '创建')
  await expect(dialog.getByRole('tab')).toHaveText(tabs)
  await dialog.getByPlaceholder('请输入 Agent 名称', { exact: true }).fill('跨页签 Agent')
  await dialog.getByPlaceholder('请输入描述', { exact: true }).fill('保留描述')
  await selectTab(dialog, '角色提示词')
  await dialog.getByPlaceholder(promptPlaceholder).fill('保留角色定义')
  await selectTab(dialog, '最佳实践')
  await dialog.getByRole('button', { name: '+ 添加经验', exact: true }).click()
  await dialog.getByPlaceholder('请输入经验正文（最长 300 字）').fill('保留经验')
  await dialog.locator('.el-tab-pane:visible .el-switch').click()
  await selectTab(dialog, '工具能力')
  await chooseOption(page, dialog, 'Skills', 'mock-skill')
  await chooseOption(page, dialog, 'MCP 服务器', 'mock-mcp（HTTP）')
  await selectTab(dialog, '运行设置')
  await dialog.locator('.el-tab-pane:visible .el-switch').click()
  await chooseOption(page, dialog, '默认模型', 'mock-model')
  for (const name of tabs) {
    await selectTab(dialog, name)
    if (name === '基本信息') {
      await expect(dialog.getByPlaceholder('请输入 Agent 名称', { exact: true })).toHaveValue('跨页签 Agent')
      await expect(dialog.getByPlaceholder('请输入描述', { exact: true })).toHaveValue('保留描述')
    } else if (name === '角色提示词') await expect(dialog.getByPlaceholder(promptPlaceholder)).toHaveValue('保留角色定义')
    else if (name === '最佳实践') {
      await expect(dialog.getByPlaceholder('请输入经验正文（最长 300 字）')).toHaveValue('保留经验')
      await expect(dialog.getByRole('switch')).not.toBeChecked()
    } else if (name === '工具能力') {
      await expect(dialog.getByRole('tabpanel', { name, exact: true })).toContainText('mock-skill')
      await expect(dialog.getByRole('tabpanel', { name, exact: true })).toContainText('mock-mcp（HTTP）')
    } else {
      await expect(dialog.getByRole('switch')).toBeChecked()
      await expect(dialog.getByRole('tabpanel', { name, exact: true })).toContainText('mock-model')
    }
  }
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes).toEqual([{ method: 'POST', path: '/api/v1/agents', payload: {
    avatarUrl: null, name: '跨页签 Agent', description: '保留描述', systemPrompt: '保留角色定义',
    skillNames: ['mock-skill'], mcpServerIds: [21], isDefault: 1, defaultModelId: 11,
    experiences: [{ id: null, content: '保留经验', sortOrder: 0, enabled: false }],
  } }])
})

test('hidden required errors select the appropriate tab without saving', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openDialog(page, '创建')
  await selectTab(dialog, '运行设置')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: '基本信息', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.el-form-item__error', { hasText: '请输入 Agent 名称' })).toBeVisible()
  await dialog.getByPlaceholder('请输入 Agent 名称', { exact: true }).fill('校验 Agent')
  await selectTab(dialog, '工具能力')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: '角色提示词', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.el-form-item__error', { hasText: '请输入角色定义' })).toBeVisible()
  await dialog.getByPlaceholder(promptPlaceholder).fill('有效角色')
  await selectTab(dialog, '最佳实践')
  await dialog.getByRole('button', { name: '+ 添加经验', exact: true }).click()
  await selectTab(dialog, '运行设置')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: '最佳实践', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('第 1 条经验不能为空', { exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})

for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
  test(`avatar upload accepts ${mimeType} multipart and saves the returned URL`, async ({ page }) => {
    const state = await setup(page)
    const dialog = await openDialog(page, '编辑')
    const extension = mimeType.split('/')[1]
    const file = { name: `avatar.${extension}`, mimeType, buffer: png }
    const input = dialog.locator('input[type="file"]')
    await expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp')
    await input.setInputFiles(file)
    await expect(dialog.locator('img[src$="/uploads/uuid.png"]')).toBeVisible()
    expect(state.uploads).toHaveLength(1)
    const upload = state.uploads[0]
    expect(upload.method()).toBe('POST')
    expect(new URL(upload.url()).pathname).toBe('/api/v1/agents/avatar')
    const contentType = upload.headers()['content-type']
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    // Parse the real request body rather than merely asserting an upload occurred.
    const multipart = await new Response(new Uint8Array(upload.postDataBuffer()!), {
      headers: { 'Content-Type': contentType },
    }).formData()
    expect([...multipart.keys()]).toEqual(['file'])
    const uploaded = multipart.get('file') as File
    expect(uploaded.name).toBe(file.name)
    expect(uploaded.type).toBe(mimeType)
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(file.buffer)
    expect(state.writes).toHaveLength(0)
    await selectTab(dialog, '角色提示词')
    await selectTab(dialog, '基本信息')
    await expect(dialog.locator('img[src$="/uploads/uuid.png"]')).toBeVisible()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]).toMatchObject({ method: 'PUT', path: '/api/v1/agents/7', payload: { avatarUrl: '/uploads/uuid.png' } })
    await expect(page.locator('.agent-identity img[src$="/uploads/uuid.png"]')).toBeVisible()
  })
}

test('invalid type and oversized avatars are rejected; exactly 2 MB is accepted', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openDialog(page, '编辑')
  const input = dialog.locator('input[type="file"]')
  await input.setInputFiles({ name: 'avatar.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
  await expect(page.getByText('请选择 PNG、JPEG 或 WebP 图片', { exact: true })).toBeVisible()
  await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) })
  await expect(page.getByText('头像大小不能超过 2 MB', { exact: true })).toBeVisible()
  await expect(dialog.locator('img[src$="/uploads/original.png"]')).toBeVisible()
  expect(state.uploads).toHaveLength(0)
  await input.setInputFiles({ name: 'boundary.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 - png.length)]) })
  await expect(dialog.locator('img[src$="/uploads/uuid.png"]')).toBeVisible()
  expect(state.uploads).toHaveLength(1)
  expect(state.writes).toHaveLength(0)
})

test('removing an avatar saves explicit null and restores the list initial', async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator('.agent-identity img[src$="/uploads/original.png"]')).toBeVisible()
  const dialog = await openDialog(page, '编辑')
  await dialog.getByRole('button', { name: '移除头像', exact: true }).click()
  await expect(dialog.locator('.el-avatar')).toHaveText('头')
  await expect(dialog.locator('button').filter({ hasText: /^上传头像$/ })).toBeVisible()
  await selectTab(dialog, '运行设置')
  await selectTab(dialog, '基本信息')
  await expect(dialog.locator('.el-avatar img')).toHaveCount(0)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0]).toMatchObject({ method: 'PUT', path: '/api/v1/agents/7', payload: { avatarUrl: null } })
  await expect(page.locator('.agent-identity .el-avatar')).toHaveText('头')
  expect(state.uploads).toHaveLength(0)
})

test('copy inherits the avatar without reuploading and creates instead of updating', async ({ page }) => {
  const state = await setup(page)
  const dialog = await openDialog(page, '复制')
  await expect(dialog.locator('img[src$="/uploads/original.png"]')).toBeVisible()
  await selectTab(dialog, '运行设置')
  await expect(dialog.getByRole('switch')).not.toBeChecked()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0]).toMatchObject({ method: 'POST', path: '/api/v1/agents', payload: {
    name: '头像测试 Agent - 副本', avatarUrl: '/uploads/original.png', systemPrompt: '原始角色定义',
    isDefault: 0, defaultModelId: null,
  } })
  expect(state.uploads).toHaveLength(0)
})

test('mobile cards and fullscreen form allow all tabs, avatar removal and saving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await setup(page)
  await expect(page.locator('.mobile-card-list img[src$="/uploads/original.png"]')).toBeVisible()
  const dialog = await openDialog(page, '编辑')
  await expect(dialog.locator('.el-dialog')).toHaveClass(/is-fullscreen/)
  const bounds = await dialog.locator('.el-dialog').boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await dialog.getByPlaceholder('请输入 Agent 名称', { exact: true }).fill('移动端 Agent')
  // Use the tab-strip scroll controls, as a touch user would, without forced clicks.
  for (const name of tabs.slice(1)) {
    const tab = dialog.getByRole('tab', { name, exact: true })
    const strip = await dialog.locator('.el-tabs__nav-scroll').boundingBox()
    const tabBounds = await tab.boundingBox()
    if (strip && tabBounds && tabBounds.x + tabBounds.width > strip.x + strip.width) {
      await dialog.locator('.el-tabs__nav-next').click()
    }
    await selectTab(dialog, name)
  }
  await dialog.locator('.el-tabs__nav-prev').click()
  await selectTab(dialog, '基本信息')
  await expect(dialog.getByPlaceholder('请输入 Agent 名称', { exact: true })).toHaveValue('移动端 Agent')
  await dialog.getByRole('button', { name: '移除头像', exact: true }).click()
  const save = dialog.getByRole('button', { name: '保存', exact: true })
  await expect(save).toBeInViewport()
  await save.click()
  await expect(dialog).not.toBeVisible()
  expect(state.writes[0]).toMatchObject({ method: 'PUT', payload: { name: '移动端 Agent', avatarUrl: null } })
  await expect(page.locator('.mobile-card-title')).toHaveText('移动端 Agent')
  await expect(page.locator('.mobile-card-head .el-avatar')).toHaveText('移')
})
