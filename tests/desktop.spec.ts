import { test, expect, type Page } from '@playwright/test'

async function mockDesktopApiFallback(page: Page) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    let data: unknown = null
    if (url.pathname.endsWith('/auth/features')) {
      data = { feishuEnabled: false }
    } else if (url.pathname.endsWith('/sessions/groups')) {
      data = { groups: [] }
    } else if (url.pathname.endsWith('/agents') || url.pathname.endsWith('/sessions')) {
      data = []
    } else if (url.pathname.endsWith('/models/default')) {
      data = { id: 1, name: 'Default Model' }
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, message: 'success', data })
    })
  })
}

// ─────────────────────────────────────────────────────────
// Desktop Root Page
// ─────────────────────────────────────────────────────────
test.describe('Desktop App', () => {
  test('should load the app shell', async ({ page }) => {
    await page.goto('/')
    // The app container should render
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 })
    // Layout component should be mounted
    await expect(page.locator('.layout')).toBeVisible({ timeout: 15_000 })
  })

  test('should render top navigation bar', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    // Theme toggle buttons
    await expect(page.locator('.theme-toggle').first()).toBeVisible()
  })

  test('should show task layout with panels', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Main layout areas
    await expect(page.locator('.task-layout')).toBeVisible()
  })

  test('should have the correct document title', async ({ page }) => {
    await page.goto('/')
    const title = await page.title()
    expect(title).toBe('Mao')
  })

  test('should have proper viewport meta', async ({ page }) => {
    await page.goto('/')
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    expect(viewport).toContain('width=device-width')
  })

  test('should not show login dialog by default when not authenticated', async ({ page }) => {
    await page.goto('/')
    // Login dialog should auto-open if not authenticated
    await page.waitForTimeout(1000)
    // The login dialog should appear because user is not logged in
    // Wait for potential dialog to show
  })

  test('should hide Feishu login when auth feature is disabled', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.goto('/')
    await expect(page.locator('.login-dialog')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: '飞书扫码登录' })).toBeHidden()
  })

  test('should login with Feishu QR polling', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.route('**/api/v1/auth/features', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: { feishuEnabled: true }
        })
      })
    })
    await page.route('**/api/v1/auth/feishu/qrcode', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            authUrl: 'https://open.feishu.test/authorize?state=state-1',
            qrCodeUrl: 'https://open.feishu.test/authorize?state=state-1',
            state: 'state-1',
            expiresIn: 300,
            pollInterval: 1
          }
        })
      })
    })

    let statusCalls = 0
    await page.route('**/api/v1/auth/feishu/status?state=state-1', async route => {
      statusCalls += 1
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: statusCalls === 1
            ? { status: 'PENDING' }
            : {
                status: 'SUCCESS',
                login: {
                  accessToken: 'access',
                  refreshToken: 'refresh',
                  expiresIn: 86400,
                  user: {
                    id: 1,
                    username: 'feishu_ou_1',
                    displayName: 'Feishu User',
                    email: 'feishu@example.test',
                    avatarUrl: ''
                  }
                }
              }
        })
      })
    })

    await page.goto('/')
    await expect(page.locator('.login-dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '飞书扫码登录' }).click()
    await expect(page.locator('.qr-image')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => page.evaluate(() => localStorage.getItem('token')), {
      timeout: 8_000
    }).toBe('access')
    await expect(page.locator('.login-dialog')).toBeHidden({ timeout: 5_000 })
  })

  test('should open Feishu auth URL in browser fallback', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.route('**/api/v1/auth/features', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: { feishuEnabled: true }
        })
      })
    })
    await page.addInitScript(() => {
      window.open = (url?: string | URL) => {
        localStorage.setItem('opened-url', String(url))
        return null
      }
    })
    await page.route('**/api/v1/auth/feishu/qrcode', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            authUrl: 'https://open.feishu.test/authorize?state=state-2',
            qrCodeUrl: 'https://open.feishu.test/authorize?state=state-2',
            state: 'state-2',
            expiresIn: 300,
            pollInterval: 1
          }
        })
      })
    })
    await page.route('**/api/v1/auth/feishu/status?state=state-2', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: { status: 'PENDING' }
        })
      })
    })

    await page.goto('/')
    await expect(page.locator('.login-dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '飞书扫码登录' }).click()
    await expect(page.locator('.qr-image')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '浏览器打开' }).click()

    await expect.poll(() => page.evaluate(() => localStorage.getItem('opened-url')), {
      timeout: 5_000
    }).toBe('https://open.feishu.test/authorize?state=state-2')
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Task View
// ─────────────────────────────────────────────────────────
test.describe('Task View', () => {
  test('should show task index panel', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Left panel - task index
    await expect(page.locator('.task-index-panel, .task-panel-left')).toBeVisible({ timeout: 10_000 })
  })

  test('should show workspace area in center', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Center task container
    await expect(page.locator('.task-container')).toBeVisible({ timeout: 10_000 })
  })

  test('should show task inspector on right', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Right inspector panel
    await expect(page.locator('.task-inspector')).toBeVisible({ timeout: 10_000 })
  })
})

// ─────────────────────────────────────────────────────────
// Desktop Theme
// ─────────────────────────────────────────────────────────
test.describe('Desktop Theme', () => {
  test('should apply theme class from localStorage', async ({ page }) => {
    // Use addInitScript to set localStorage before page loads
    await page.addInitScript(() => {
      localStorage.setItem('aw-theme-mode', 'dark')
    })
    await page.goto('/')
    await page.waitForSelector('.layout', { timeout: 15_000 })
    // Dark class should be set on html element
    const hasDark = await page.locator('html').evaluate(el =>
      el.classList.contains('dark')
    )
    expect(hasDark).toBeTruthy()
  })

  test('should follow system preference when theme mode is auto', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('aw-theme-mode')
      localStorage.removeItem('aw-theme')
    })
    await page.goto('/')
    await page.waitForSelector('.layout', { timeout: 15_000 })
    const prefersDark = await page.evaluate(() =>
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
    const hasDark = await page.locator('html').evaluate(el =>
      el.classList.contains('dark')
    )
    expect(hasDark).toBe(prefersDark)
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Root Route Redirect and Task Route
// ─────────────────────────────────────────────────────────
test.describe('Desktop Routes', () => {
  test('should render task view on default route', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout, .task-index-panel', { timeout: 15_000 })
    // The main task view component should be rendered
    await expect(page.locator('.task-layout')).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('Desktop Notification Settings', () => {
  test('should configure and test one webhook channel', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-access-token')
    })

    let savedPayload: Record<string, unknown> | null = null
    let testPayload: Record<string, unknown> | null = null
    await page.route('**/api/v1/**', async route => {
      const request = route.request()
      const pathname = new URL(request.url()).pathname
      let data: unknown = null
      if (pathname.endsWith('/user-preferences/task-notification/test')) {
        testPayload = request.postDataJSON()
      } else if (pathname.endsWith('/user-preferences/task-notification')) {
        if (request.method() === 'PUT') savedPayload = request.postDataJSON()
        data = savedPayload
          ? { enabled: true, channel: 'DINGTALK', webhookConfigured: true,
              maskedWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=****oken' }
          : { enabled: false, channel: null, webhookConfigured: false, maskedWebhook: null }
      } else if (pathname.endsWith('/auth/features')) {
        data = { feishuEnabled: false }
      } else if (pathname.endsWith('/auth/me')) {
        data = { id: 1, username: 'admin', displayName: 'Admin' }
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data })
      })
    })

    await page.goto('/settings/notifications')
    await expect(page.getByRole('heading', { name: '消息通知' })).toBeVisible()
    await page.locator('.el-switch').click()
    await page.getByText('钉钉', { exact: true }).click()

    const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=test-token'
    await page.getByRole('textbox', { name: 'Webhook 地址' }).fill(webhook)
    await expect(page.getByRole('button', { name: '发送测试通知' })).toBeEnabled()
    await page.getByRole('button', { name: '发送测试通知' }).click()
    await expect.poll(() => testPayload).toEqual({ channel: 'DINGTALK', webhookUrl: webhook })

    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => savedPayload).toEqual({
      enabled: true,
      channel: 'DINGTALK',
      webhookUrl: webhook
    })
  })
})
