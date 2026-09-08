import { test, expect, type Page } from '@playwright/test'
import { COMPANY_SSO_KEY, defaultCompanySsoConfig, parseCompanySsoConfig, splitAllowlist, validateCompanySsoConfig } from '../admin/src/views/settings/companySsoConfig'

const defaults = defaultCompanySsoConfig()

test.describe('Company SSO validation', () => {
  test('defaults only apply to an absent key', () => {
    expect(parseCompanySsoConfig(undefined)).toEqual(defaults)
    for (const raw of [null, '', '{', 'null', '[]', '{}', JSON.stringify({ ...defaults, enabled: 'false' })]) {
      expect(() => parseCompanySsoConfig(raw)).toThrow()
    }
    for (const field of Object.keys(defaults)) {
      const value: Record<string, unknown> = { ...defaults }
      delete value[field]
      expect(() => parseCompanySsoConfig(JSON.stringify(value))).toThrow()
    }
  })

  test('normalizes comma/newline lists and domain case without wildcard expansion', () => {
    const config = validateCompanySsoConfig({
      ...defaults,
      allowedDomains: splitAllowlist(' Example.COM, sub.example.com\nexample.com\r\n ,'),
      allowedOrigins: splitAllowlist('https://portal.example.com,\nhttps://portal.example.com\nhttps://portal.example.com:8443'),
    })
    expect(config.allowedDomains).toEqual(['example.com', 'sub.example.com'])
    expect(config.allowedOrigins).toEqual(['https://portal.example.com', 'https://portal.example.com:8443'])
  })

  test('rejects invalid domains, non-exact origins and wrong array fields', () => {
    for (const domain of ['*.example.com', 'https://example.com', 'example.com:443', 'example.com/path', '-bad.com', 'example..com', '']) {
      expect(() => validateCompanySsoConfig({ ...defaults, allowedDomains: [domain] })).toThrow(/allowedDomains/)
    }
    for (const origin of ['http://example.com', 'https://example.com/', 'https://example.com/a', 'https://example.com?x=1', 'https://example.com#x', 'https://user:pass@example.com', 'https://*.example.com', 'https://EXAMPLE.com', 'https://example.com:443']) {
      expect(() => validateCompanySsoConfig({ ...defaults, allowedOrigins: [origin] })).toThrow(/allowedOrigins/)
    }
    for (const field of ['allowedDomains', 'allowedOrigins']) {
      for (const value of ['example.com', null, [123]]) {
        expect(() => validateCompanySsoConfig({ ...defaults, [field]: value })).toThrow(field)
      }
    }
  })

  test('requires both allowlists when enabled and rejects unknown or whitespace-padded stored fields', () => {
    for (const lists of [
      { allowedDomains: [], allowedOrigins: [] },
      { allowedDomains: ['example.com'], allowedOrigins: [] },
      { allowedDomains: [], allowedOrigins: ['https://portal.example.com'] },
    ]) {
      expect(() => validateCompanySsoConfig({ ...defaults, ...lists, enabled: true })).toThrow('均不能为空')
    }
    expect(validateCompanySsoConfig({ ...defaults, enabled: true, allowedDomains: ['example.com'], allowedOrigins: ['https://portal.example.com'] }).enabled).toBe(true)
    for (const extra of [{ requireHttps: true }, { checkUrl: 'https://example.com' }, { typo: 1 }]) {
      expect(() => parseCompanySsoConfig(JSON.stringify({ ...defaults, ...extra }))).toThrow('未知字段')
    }
    for (const domain of ['localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.1', '0177.0.0.1', '[::1]', ' example.com', 'example.com\n']) {
      expect(() => parseCompanySsoConfig(JSON.stringify({ ...defaults, allowedDomains: [domain] }))).toThrow('allowedDomains')
    }
    for (const origin of [' https://example.com', 'https://example.com ', 'https://example.com\n']) {
      expect(() => parseCompanySsoConfig(JSON.stringify({ ...defaults, allowedOrigins: [origin] }))).toThrow('allowedOrigins')
    }
  })

  test('validates integer bounds and submits all five fields even when disabled', () => {
    for (const [field, min, max] of [['accessTtlSeconds', 60, 3600], ['timeoutMs', 1, 30000]] as const) {
      for (const value of [min, max]) expect(validateCompanySsoConfig({ ...defaults, [field]: value })[field]).toBe(value)
      for (const value of [min - 1, max + 1, 1.5, '1800', undefined, NaN]) {
        expect(() => validateCompanySsoConfig({ ...defaults, [field]: value })).toThrow(field)
      }
    }
    expect(validateCompanySsoConfig(defaults)).toEqual(defaults)
  })
})

async function openSettings(page: Page, raw: string | null | undefined, canWrite = true, failSave = false, editable: number | null = 1) {
  const writes: Array<{ url: string; body: { value: string } }> = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/login')) data = { accessToken: 'sso-test-token', refreshToken: 'sso-test-refresh' }
    if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', permissions: ['settings:read', ...(canWrite ? ['settings:write'] : [])] }
    if (path.endsWith('/system-settings')) data = raw === undefined ? [] : [{ settingKey: COMPANY_SSO_KEY, value: raw, editable, category: '认证' }]
    if (request.method() === 'PUT') {
      writes.push({ url: path, body: request.postDataJSON() })
      if (failSave) {
        await route.fulfill({ status: 500, json: { code: 500, message: '保存失败测试' } })
        return
      }
      raw = request.postDataJSON().value
    }
    await route.fulfill({ json: { code: 0, data } })
  })
  // 与管理后台现有用例一致，通过登录页进入；API 全部隔离，不改真实配置。
  await page.goto('/admin/login')
  await page.locator('input[placeholder="用户名"]').fill('admin')
  await page.locator('input[placeholder="密码"]').fill('admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/dashboard/)
  await page.goto('/admin/settings')
  await expect(page.locator('#setting-group-company-sso')).toBeVisible()
  return writes
}

test.describe('Company SSO settings UI', () => {
  test('shows defaults and saves a normalized complete snapshot through the single-key API', async ({ page }) => {
    const writes = await openSettings(page, JSON.stringify(defaults))
    const panel = page.locator('#setting-group-company-sso')
    await expect(page.locator('.toc-item').filter({ hasText: '公司 SSO' })).toBeVisible()
    await expect(panel.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await expect(panel.getByRole('spinbutton').nth(0)).toHaveValue('1800')
    await expect(panel.getByRole('spinbutton').nth(1)).toHaveValue('3000')
    await panel.locator('.el-switch').click()
    await panel.locator('textarea').nth(0).fill(' Example.COM,sub.example.com\nexample.com ')
    await panel.locator('textarea').nth(1).fill('https://portal.example.com\nhttps://portal.example.com:8443')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.el-message--success')).toContainText('新换票立即生效，不需重启')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.url).toBe(`/api/v1/system-settings/${COMPANY_SSO_KEY}`)
    expect(JSON.parse(writes[0]!.body.value)).toEqual({ ...defaults, enabled: true, allowedDomains: ['example.com', 'sub.example.com'], allowedOrigins: ['https://portal.example.com', 'https://portal.example.com:8443'] })
    await expect(panel).toContainText('MaoChat.init')
    await expect(panel).toContainText('同一员工身份体系')
    await expect(page.locator('.setting-section').filter({ hasText: '单条 JSON 完整快照保存' })).toHaveCount(1)
  })

  test('missing configuration requires initialization and cannot save', async ({ page }) => {
    const writes = await openSettings(page, undefined)
    const panel = page.locator('#setting-group-company-sso')
    await expect(panel).toContainText('配置项未初始化')
    await expect(panel).toContainText('数据库迁移')
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await expect(panel.locator('textarea').first()).toBeDisabled()
    expect(writes).toHaveLength(0)
  })

  for (const editable of [0, null, 2]) {
    test(`only editable=1 allows saving: ${editable}`, async ({ page }) => {
      const writes = await openSettings(page, JSON.stringify(defaults), true, false, editable)
      const panel = page.locator('#setting-group-company-sso')
      await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      await expect(panel.locator('textarea').first()).toBeDisabled()
      expect(writes).toHaveLength(0)
    })
  }

  for (const raw of ['{', JSON.stringify({ ...defaults, timeoutMs: '3000' }), JSON.stringify({ ...defaults, requireHttps: true }), JSON.stringify({ ...defaults, allowedDomains: [' example.com'] })]) {
    test(`blocks overwriting malformed stored configuration: ${raw}`, async ({ page }) => {
      const writes = await openSettings(page, raw)
      const panel = page.locator('#setting-group-company-sso')
      await expect(panel.getByRole('alert').first()).toContainText('配置读取失败')
      await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      await expect(panel.locator('textarea').first()).toBeDisabled()
      expect(writes).toHaveLength(0)
    })
  }

  test('read-only users cannot edit or save', async ({ page }) => {
    const writes = await openSettings(page, JSON.stringify(defaults), false)
    const panel = page.locator('#setting-group-company-sso')
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await expect(panel.locator('textarea').first()).toBeDisabled()
    await expect(panel.getByRole('spinbutton').first()).toBeDisabled()
    expect(writes).toHaveLength(0)
  })

  test('invalid input sends no request; failed save preserves edits for retry', async ({ page }) => {
    const writes = await openSettings(page, JSON.stringify(defaults), true, true)
    const panel = page.locator('#setting-group-company-sso')
    await panel.locator('textarea').nth(1).fill('https://portal.example.com/path')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.el-message--error')).toContainText('精确 HTTPS Origin')
    expect(writes).toHaveLength(0)
    await panel.locator('textarea').nth(1).fill('https://portal.example.com')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.el-message--error').filter({ hasText: '保存失败测试' })).toBeVisible()
    await expect(panel.locator('textarea').nth(1)).toHaveValue('https://portal.example.com')
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    expect(writes).toHaveLength(1)
  })
})
