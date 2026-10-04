import { test, expect, type Page } from '@playwright/test'

async function mockDesktopApiFallback(page: Page) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    let data: unknown = null
    if (url.pathname.endsWith('/auth/features')) {
      data = { feishuEnabled: false }
    } else if (url.pathname.endsWith('/users/me')) {
      data = { id: 1, username: 'admin', displayName: 'Admin' }
    } else if (url.pathname.endsWith('/sessions/groups')) {
      data = { groups: [] }
    } else if (url.pathname.endsWith('/sessions/search')) {
      data = { items: [] }
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

const SEARCH_RESULTS = {
  items: [
    {
      id: 11,
      title: '修复登录 Bug',
      sessionType: 'NORMAL',
      parentSessionId: null,
      updatedAt: '2026-08-07T10:30',
      phase: 'COMPLETED',
      agentName: '默认 Agent',
      snippet: '……帮我看看登录页面为什么报 500 错误……'
    },
    {
      id: 22,
      title: '边路整理文档',
      sessionType: 'SIDE_TASK',
      parentSessionId: 3,
      updatedAt: '2026-08-07T09:00',
      phase: 'RUNNING',
      agentName: '默认 Agent',
      snippet: '……把登录流程整理成文档……'
    }
  ]
}

/** 已登录 + 全量 API mock：/sessions/search 返回固定结果，/sessions/{id} 系列返回空对象兜底。 */
async function mockLoggedInDesktopApi(page: Page, onSearch?: (keyword: string) => void) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    let data: unknown = null
    if (pathname.endsWith('/users/me')) {
      data = { id: 1, username: 'admin', displayName: 'Admin' }
    } else if (pathname.endsWith('/sessions/search')) {
      onSearch?.(url.searchParams.get('keyword') || '')
      data = SEARCH_RESULTS
    } else if (pathname.endsWith('/sessions/groups')) {
      data = { groups: [] }
    } else if (pathname.endsWith('/agents') || pathname.endsWith('/models/default')) {
      data = pathname.endsWith('/models/default') ? { id: 1, name: 'Default Model' } : []
    } else if (pathname.includes('/sessions/')) {
      // /sessions/{id}、/sessions/{id}/side-tasks、/sessions/{id}/subagents 等
      data = {}
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, message: 'success', data })
    })
  })
}

// ─────────────────────────────────────────────────────────
// Desktop Login Page（未登录）
// ─────────────────────────────────────────────────────────
test.describe('Desktop App - Not Logged In', () => {
  test('should redirect to login page when not authenticated', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 })
    await expect(page.locator('.login-card')).toBeVisible({ timeout: 10_000 })
    // 未登录不允许看到主布局
    await expect(page.locator('.layout')).toHaveCount(0)
  })

  test('should carry redirect query for deep links', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.goto('/tasks/1')
    await expect(page).toHaveURL(/\/login\?redirect=\/tasks\/1$/, { timeout: 15_000 })
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

  test('should hide Feishu login when auth feature is disabled', async ({ page }) => {
    await mockDesktopApiFallback(page)
    await page.goto('/')
    await expect(page.locator('.login-card')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: '飞书登录' })).toHaveCount(0)
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

    // window.open 新开页会导航到未路由的 https://open.feishu.test（ERR_ABORTED），
    // Playwright 下返回的 WindowProxy 不可靠导致 openExternalUrl 误判弹窗被拦截。
    // mock 成 noopener 成功窗口（truthy，非 null），只验证进入轮询流程。
    await page.addInitScript(() => {
      window.open = () => ({ closed: false }) as Window
    })

    await page.goto('/')
    await expect(page.locator('.login-card')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '飞书登录' }).first().click()
    await expect(page.locator('.feishu-status')).toBeVisible({ timeout: 5_000 })

    await expect.poll(() => page.evaluate(() => localStorage.getItem('token')), {
      timeout: 8_000
    }).toBe('access')
    // 登录成功后离开登录页
    await expect(page).not.toHaveURL(/\/login/, { timeout: 8_000 })
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
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
    await expect(page.locator('.login-card')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '飞书登录' }).first().click()

    // window.open 返回 null 即弹窗被拦截：登录页提示错误并退回密码登录模式，
    // feishu-status 面板随之卸载。这里断言拦截文案以 ElMessage 形式弹出。
    await expect.poll(() => page.evaluate(() => localStorage.getItem('opened-url')), {
      timeout: 5_000
    }).toBe('https://open.feishu.test/authorize?state=state-2')
    await expect(page.locator('.el-message--error').first()).toContainText('授权页面被浏览器拦截')
  })
})

// ─────────────────────────────────────────────────────────
// Desktop App（已登录）
// ─────────────────────────────────────────────────────────
test.describe('Desktop App - Logged In', () => {
  test('should load the app shell', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    // The app container should render
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 })
    // Layout component should be mounted
    await expect(page.locator('.layout')).toBeVisible({ timeout: 15_000 })
  })

  test('should render top navigation bar', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    // Theme toggle buttons
    await expect(page.locator('.theme-toggle').first()).toBeVisible()
  })

  test('should show task layout with panels', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Main layout areas
    await expect(page.locator('.task-layout')).toBeVisible()
  })

  test('should leave login page immediately when already authenticated', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/login')
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 })
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
  })

  test('should ignore unsafe redirect targets', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/login?redirect=//evil.test')
    await expect(page).toHaveURL(/:\/\/[^/]+\/$|localhost:\d+\/$/, { timeout: 10_000 })
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Task View
// ─────────────────────────────────────────────────────────
test.describe('Task View', () => {
  test('should show task index panel', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Left panel - task index
    await expect(page.locator('.task-index-panel, .task-panel-left')).toBeVisible({ timeout: 10_000 })
  })

  test('should show workspace area in center', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Center task container
    await expect(page.locator('.task-container')).toBeVisible({ timeout: 10_000 })
  })

  test('should show task inspector on right', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
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
    // Dark class should be set on html element（未登录停在登录页，主题同样生效）
    await page.waitForSelector('#app > *', { timeout: 15_000 })
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
    await page.waitForSelector('#app > *', { timeout: 15_000 })
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
    await mockLoggedInDesktopApi(page)
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
      } else if (pathname.endsWith('/users/me')) {
        data = { id: 1, username: 'admin', displayName: 'Admin' }
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data })
      })
    })

    await page.goto('/settings/notifications')
    await expect(page.getByRole('heading', { name: '消息通知' })).toBeVisible()
    // 开启「任务完成通知」总开关（页面 header 内唯一一个 el-switch）
    await page.locator('.page-header .el-switch').click()
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

// ─────────────────────────────────────────────────────────
// Desktop - Session Search
// ─────────────────────────────────────────────────────────
test.describe('Session Search', () => {
  test('should search by user message and jump to main session', async ({ page }) => {
    let searchKeyword = ''
    await mockLoggedInDesktopApi(page, kw => { searchKeyword = kw })

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await page.locator('.search-toggle').first().click()
    await expect(page.locator('.session-search-dialog input')).toBeVisible({ timeout: 5_000 })

    await page.locator('.session-search-dialog input').fill('登录')
    await expect.poll(() => searchKeyword, { timeout: 8_000 }).toBe('登录')
    await expect(page.locator('.search-result-item')).toHaveCount(2)
    await expect(page.locator('.snippet-hit').first()).toContainText('登录')

    await page.locator('.search-result-item').first().click()
    await expect(page).toHaveURL(/\/tasks\/11$/, { timeout: 8_000 })
  })

  test('should jump to parent session and open side task tab', async ({ page }) => {
    await mockLoggedInDesktopApi(page)

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await page.locator('.search-toggle').first().click()
    await page.locator('.session-search-dialog input').fill('登录')
    await expect(page.locator('.search-result-item')).toHaveCount(2)

    // 第二个结果为边路会话（parentSessionId=3）→ 跳父会话并打开边路 Tab
    await page.locator('.search-result-item').nth(1).click()
    await expect(page).toHaveURL(/\/tasks\/3$/, { timeout: 8_000 })
    await expect(page.locator('.center-tab-bar .tab-item').filter({ hasText: '边路整理文档' }))
      .toBeVisible({ timeout: 8_000 })
  })

  test('should stay on login page when not logged in', async ({ page }) => {
    let searchCalled = false
    await page.route('**/api/v1/sessions/search', async route => {
      searchCalled = true
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data: { items: [] } })
      })
    })

    await page.goto('/')
    // 未登录到不了顶栏，只能停在登录页；搜索接口不应被调用
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 })
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(500)
    expect(searchCalled).toBeFalsy()
    await expect(page.locator('.top-nav')).toHaveCount(0)
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Settings entry
// ─────────────────────────────────────────────────────────
test.describe('Desktop - Settings entry', () => {
  test('should show settings gear on top nav and open settings page', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/settings/profile')
    await expect(page.locator('.settings-toggle')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.settings-toggle')).toHaveClass(/active/)
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.locator('.settings-title')).toHaveText('设置')
    await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible()
  })

  test('should open settings when clicking top nav gear from workbench', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible({ timeout: 15_000 })
    await page.locator('.settings-toggle').click()
    await expect(page.locator('.settings-layout')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.settings-title')).toHaveText('设置')
  })

  test('should keep profile and logout in avatar menu without settings', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await page.getByRole('button', { name: '用户菜单' }).click()
    await expect(page.getByRole('menuitem', { name: '个人信息' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '退出登录' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '设置' })).toHaveCount(0)
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - 任务分组右键重命名
// 依赖 e2e 种子：一条 LOCAL 会话（workspace=/home/mao-e2e/demo-project，分组名 demo-project）
// ─────────────────────────────────────────────────────────
test.describe('Task Group Rename', () => {
  /** 真实登录（连隔离后端 :9180），返回带 token 的已登录上下文。 */
  async function loginDesktop(page: Page) {
    await page.goto('/login')
    await page.waitForSelector('.login-card', { timeout: 15_000 })
    await page.fill('input[placeholder="用户名"]', 'admin')
    await page.fill('input[placeholder="密码"]', 'admin123')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForSelector('.task-layout, .task-index-panel', { timeout: 15_000 })
  }

  test('should rename group via context menu and persist after reload', async ({ page }) => {
    await loginDesktop(page)
    await page.goto('/')

    const groupHeader = page.locator('.session-group .group-header').filter({ hasText: 'demo-project' }).first()
    await expect(groupHeader).toBeVisible({ timeout: 10_000 })

    // 右键分组头出现菜单 → 重命名
    await groupHeader.click({ button: 'right' })
    const menuItem = page.locator('.task-context-menu .context-menu-item', { hasText: '重命名' })
    await expect(menuItem).toBeVisible()
    await menuItem.click()

    // 行内编辑：输入别名并回车
    const renameInput = page.locator('.group-header .group-rename-input')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('演示项目')
    await renameInput.press('Enter')

    // 标题变为别名，且 hover tooltip 显示推导名
    const renamedHeader = page.locator('.session-group .group-header').filter({ hasText: '演示项目' }).first()
    await expect(renamedHeader).toBeVisible()
    await expect(renamedHeader.locator('.group-label')).toHaveAttribute('title', /demo-project/)

    // 偏好已持久化（300ms 防抖后发出 PUT）：直连隔离后端 :9180 轮询校验
    await expect.poll(async () =>
      page.evaluate(async () => {
        const token = localStorage.getItem('token')
        if (!token) return {}
        try {
          const r = await fetch('http://localhost:9180/api/v1/user-preferences/task-panel', {
            headers: { Authorization: `Bearer ${token}` },
          })
          const d = await r.json()
          return d?.data?.groupAliases ?? {}
        } catch {
          return {}
        }
      })
    , { timeout: 10_000 }).toEqual(expect.objectContaining({ 'LOCAL:/home/mao-e2e/demo-project': '演示项目' }))

    // 刷新后别名仍生效
    await page.reload()
    await page.waitForSelector('.task-index-panel', { timeout: 15_000 })
    await expect(page.locator('.session-group .group-header').filter({ hasText: '演示项目' }).first())
      .toBeVisible({ timeout: 10_000 })

    // 右键 → 重置名称，恢复默认名
    const renamedAgain = page.locator('.session-group .group-header').filter({ hasText: '演示项目' }).first()
    await renamedAgain.click({ button: 'right' })
    const resetItem = page.locator('.task-context-menu .context-menu-item', { hasText: '重置名称' })
    await expect(resetItem).toBeVisible()
    await resetItem.click()
    await expect(page.locator('.session-group .group-header').filter({ hasText: 'demo-project' }).first())
      .toBeVisible({ timeout: 10_000 })
  })

  test('should offer rename for system bucket groups (方案 A)', async ({ page }) => {
    await loginDesktop(page)
    await page.goto('/')

    // 种子里无 workspace 的 LOCAL 会话落入「未设置」分组；方案 A 下系统桶也可改名
    const unassignedHeader = page.locator('.session-group .group-header').filter({ hasText: '未设置' }).first()
    if (await unassignedHeader.count() === 0) return // 无系统桶分组可见时跳过
    await unassignedHeader.click({ button: 'right' })
    const menuItem = page.locator('.task-context-menu .context-menu-item', { hasText: '重命名' })
    await expect(menuItem).toBeVisible()
    await menuItem.click()

    const renameInput = page.locator('.group-header .group-rename-input')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('杂项')
    await renameInput.press('Enter')
    await expect(page.locator('.session-group .group-header').filter({ hasText: '杂项' }).first()).toBeVisible()

    // 重置恢复「未设置」
    const renamed = page.locator('.session-group .group-header').filter({ hasText: '杂项' }).first()
    await renamed.click({ button: 'right' })
    const resetItem = page.locator('.task-context-menu .context-menu-item', { hasText: '重置名称' })
    await expect(resetItem).toBeVisible()
    await resetItem.click()
    await expect(page.locator('.session-group .group-header').filter({ hasText: '未设置' }).first())
      .toBeVisible({ timeout: 10_000 })
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Memory Settings（我的记忆）
// ─────────────────────────────────────────────────────────
test.describe('Memory Settings', () => {
  interface MemoryRow {
    id: number
    scope: 'USER' | 'PROJECT'
    projectKey: string | null
    content: string
    source: 'AUTO' | 'MANUAL'
    status: 'ACTIVE' | 'DISMISSED'
    originSessionId: number | null
    createdAt: string
    updatedAt: string
  }

  function memory(id: number, content: string): MemoryRow {
    return {
      id,
      scope: 'USER',
      projectKey: null,
      content,
      source: 'MANUAL',
      status: 'ACTIVE',
      originSessionId: null,
      createdAt: '2026-10-02 10:00:00',
      updatedAt: '2026-10-02 10:00:00'
    }
  }

  test('should create, list and delete user memory, and keep auto-capture toggle', async ({ page }) => {
    let items: MemoryRow[] = [memory(1, '输出报告用中文')]
    // 默认关闭：关闭状态下现有功能零影响，开启是用户显式动作
    let autoCapture = false
    let nextId = 2

    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-access-token')
    })
    await page.route('**/api/v1/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const pathname = url.pathname
      const method = request.method()
      let data: unknown = null
      if (pathname === '/api/v1/memory' && method === 'GET') {
        data = { records: items, total: items.length, current: 1, size: 20 }
      } else if (pathname === '/api/v1/memory' && method === 'POST') {
        const payload = request.postDataJSON() as { content: string; scope: string }
        const created = memory(nextId++, payload.content)
        items = [created, ...items]
        data = created
      } else if (pathname === '/api/v1/memory/settings' && method === 'GET') {
        data = { autoCaptureEnabled: autoCapture }
      } else if (pathname === '/api/v1/memory/settings' && method === 'PATCH') {
        autoCapture = (request.postDataJSON() as { autoCaptureEnabled: boolean }).autoCaptureEnabled
        data = { autoCaptureEnabled: autoCapture }
      } else if (/^\/api\/v1\/memory\/\d+$/.test(pathname) && method === 'DELETE') {
        const id = Number(pathname.split('/').pop())
        items = items.filter(item => item.id !== id)
        data = null
      } else if (pathname.endsWith('/users/me')) {
        data = { id: 1, username: 'admin', displayName: 'Admin' }
      } else if (pathname.endsWith('/auth/features')) {
        data = { feishuEnabled: false }
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data })
      })
    })

    await page.goto('/settings/memory')
    await expect(page.locator('.page-title')).toHaveText('我的记忆')

    // 列表可见
    await expect(page.locator('.memory-card')).toHaveCount(1)
    await expect(page.locator('.memory-card').first()).toContainText('输出报告用中文')

    // 新增一条用户级记忆
    await page.getByRole('button', { name: '新增记忆' }).click()
    await expect(page.locator('.memory-dialog')).toBeVisible()
    await page.locator('.memory-dialog textarea').fill('习惯使用 pnpm 管理依赖')
    await page.locator('.memory-dialog').getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.memory-card')).toHaveCount(2)
    await expect(page.locator('.memory-card').first()).toContainText('习惯使用 pnpm 管理依赖')

    // 删除成功
    await page.locator('.memory-card').first().getByText('删除', { exact: true }).click()
    await page.getByText('确认删除', { exact: true }).click()
    await expect(page.locator('.memory-card')).toHaveCount(1)

    // 自动收集开关：默认关闭，切换后状态保持
    await expect(page.locator('.memory-toolbar .el-switch:not(.is-checked)')).toBeVisible()
    await page.locator('.memory-toolbar .el-switch').click()
    await expect.poll(() => autoCapture).toBe(true)
    await page.reload()
    await expect(page.locator('.memory-toolbar .el-switch.is-checked')).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────
// Desktop Inbox（站内收件箱）
// 全部走页面级 mock：不连隔离后端，固定喂一份收件箱数据，避免与 e2e 种子耦合。
// ─────────────────────────────────────────────────────────
type InboxRecord = {
  id: number
  kind: string
  title: string
  content: string | null
  isRead: boolean
  readAt: string | null
  sessionId: number | null
  payload: Record<string, unknown> | null
  createdAt: string
}

test.describe('Desktop Inbox', () => {
  function record(overrides: Partial<InboxRecord>): InboxRecord {
    return {
      id: 1,
      kind: 'TASK_COMPLETED',
      title: '任务已完成：整理登录流程',
      content: null,
      isRead: false,
      readAt: null,
      sessionId: 11,
      payload: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    }
  }

  async function mockInboxApi(page: Page, options: {
    items: InboxRecord[]
    unreadCount?: number
    preference?: Record<string, boolean>
    /** 模拟 Electron 桌面端（window.electronAPI 存在）：渲染仅 Electron 可见的开关。 */
    electron?: boolean
  }) {
    const unreadCount = options.unreadCount ?? options.items.filter(i => !i.isRead).length
    const preference = options.preference ?? {
      taskCompletedEnabled: true,
      questionPendingEnabled: true,
      approvalPendingEnabled: true,
      subagentDoneEnabled: false,
      systemNotifyEnabled: true,
    }
    const state = { items: options.items, unreadCount }

    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-access-token')
    })
    if (options.electron) {
      // isElectronClient() 读 window.electronAPI；种一个最小替身即可渲染
      // 「Electron 系统通知」开关（真实 Electron 由 preload 注入）。
      await page.addInitScript(() => {
        (window as any).electronAPI = { platform: 'darwin' }
      })
    }

    await page.route('**/api/v1/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const pathname = url.pathname
      const method = request.method()
      let data: unknown = null

      if (pathname === '/api/v1/inbox' && method === 'GET') {
        const unreadOnly = url.searchParams.get('unreadOnly') === 'true'
        const records = unreadOnly ? state.items.filter(item => !item.isRead) : state.items
        data = { records, total: records.length, page: 1, size: 20 }
      } else if (pathname === '/api/v1/inbox/unread-count' && method === 'GET') {
        data = { unreadCount: state.unreadCount }
      } else if (/^\/api\/v1\/inbox\/\d+\/read$/.test(pathname) && method === 'POST') {
        const id = Number(pathname.split('/')[4])
        state.items = state.items.map(item => (item.id === id ? { ...item, isRead: true } : item))
        state.unreadCount = state.items.filter(item => !item.isRead).length
        data = null
      } else if (pathname === '/api/v1/inbox/read-all' && method === 'POST') {
        state.items = state.items.map(item => ({ ...item, isRead: true }))
        state.unreadCount = 0
        data = null
      } else if (pathname === '/api/v1/inbox/preferences' && method === 'GET') {
        data = preference
      } else if (pathname.endsWith('/users/me') || pathname.endsWith('/auth/features')) {
        data = pathname.endsWith('/users/me')
          ? { id: 1, username: 'admin', displayName: 'Admin' }
          : { feishuEnabled: false }
      } else if (pathname.endsWith('/sessions/11')) {
        data = { id: '11', title: '整理登录流程', phase: 'COMPLETED' }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, message: 'success', data }) })
    })
  }

  test('铃铛显示权威未读数，抽屉渲染条目', async ({ page }) => {
    await mockInboxApi(page, {
      items: [
        record({
          id: 1,
          payload: { source: 'SCHEDULED' },
          createdAt: new Date().toISOString(),
        }),
        record({
          id: 2,
          kind: 'SUBAGENT_DONE',
          title: '子代理任务：抓取依赖版本',
          content: '结论：依赖版本已确认',
          sessionId: 12,
          payload: { status: 'FAILED' },
          isRead: true,
          createdAt: new Date(Date.now() - 3600_000).toISOString(),
        }),
        record({ id: 3, kind: 'QUESTION_PENDING', title: '有待回答的提问', sessionId: 13 }),
      ],
    })

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })

    // 权威未读数来自服务端 COUNT
    const badge = page.locator('.inbox-bell .el-badge__content')
    await expect(badge).toHaveText('2', { timeout: 10_000 })

    await page.locator('.inbox-bell').click()
    const drawer = page.locator('.el-drawer')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    await expect(drawer.getByText('站内收件箱').first()).toBeVisible()

    // 三条条目渲染（kind 图标文案 + 标题）
    await expect(page.locator('.inbox-item')).toHaveCount(3)
    await expect(page.locator('.inbox-item').first()).toContainText('任务已完成：整理登录流程')
    await expect(page.locator('.inbox-item').first()).toContainText('定时任务')
    await expect(page.locator('.inbox-item').nth(1)).toContainText('执行失败')

    // 未读红点标识
    await expect(page.locator('.inbox-item.is-unread')).toHaveCount(2)
  })

  test('点击条目标记已读并跳转关联会话', async ({ page }) => {
    await mockInboxApi(page, {
      items: [record({ id: 1 })],
      unreadCount: 1,
    })

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await expect(page.locator('.inbox-bell .el-badge__content')).toHaveText('1', { timeout: 10_000 })

    await page.locator('.inbox-bell').click()
    await expect(page.locator('.el-drawer')).toBeVisible({ timeout: 10_000 })
    await page.locator('.inbox-item').first().click()

    // 跳转到关联会话路由
    await expect(page).toHaveURL(/\/tasks\/11$/, { timeout: 10_000 })
    // 重开后条目已读、徽标归零
    await page.locator('.inbox-bell').click()
    await expect(page.locator('.inbox-item.is-unread')).toHaveCount(0, { timeout: 10_000 })
  })

  test('全部已读后徽标归零', async ({ page }) => {
    await mockInboxApi(page, {
      items: [record({ id: 1 }), record({ id: 2, kind: 'TASK_FAILED', title: '任务执行失败：打包' })],
      unreadCount: 2,
    })

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await expect(page.locator('.inbox-bell .el-badge__content')).toHaveText('2', { timeout: 10_000 })

    await page.locator('.inbox-bell').click()
    await expect(page.locator('.el-drawer')).toBeVisible({ timeout: 10_000 })
    await page.locator('.el-drawer').getByRole('button', { name: '全部已读' }).click()

    await expect(page.locator('.inbox-item.is-unread')).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator('.inbox-bell .el-badge__content')).toBeHidden({ timeout: 10_000 })
  })

  test('只看未读过滤与偏好开关渲染', async ({ page }) => {
    await mockInboxApi(page, {
      items: [
        record({ id: 1 }),
        record({ id: 2, kind: 'TASK_FAILED', title: '任务执行失败：打包', isRead: true, readAt: new Date().toISOString() }),
      ],
      unreadCount: 1,
    })

    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await page.locator('.inbox-bell').click()
    await expect(page.locator('.inbox-item')).toHaveCount(2, { timeout: 10_000 })

    // 勾选只看未读 → 仅剩 1 条
    await page.locator('.el-drawer .el-checkbox').click()
    await expect(page.locator('.inbox-item')).toHaveCount(1, { timeout: 10_000 })

    // 设置页「站内收件箱」分区：四个 kind 开关 + 独立保存按钮
    await page.goto('/settings/notifications')
    await expect(page.getByRole('heading', { name: '消息通知' })).toBeVisible({ timeout: 10_000 })
    const section = page.locator('.inbox-section')
    await expect(section).toBeVisible()
    // el-switch 的真实 input 是隐藏控件，用 aria-checked 断言开关状态（仓内其他用例同款写法）
    await expect(section.getByRole('switch', { name: '任务完成收件箱通知' })).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByRole('switch', { name: '提问待答收件箱通知' })).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByRole('switch', { name: '审批待办收件箱通知' })).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByRole('switch', { name: '子代理完成收件箱通知' })).toHaveAttribute('aria-checked', 'false')
    // 分区保存独立于整页保存（初始无改动时禁用）
    const saveBtn = section.getByRole('button', { name: '保存收件箱设置' })
    await expect(saveBtn).toBeDisabled()
    // el-switch 的可见可点区域是包裹隐藏 input 的 .el-switch 容器
    await section.locator('.el-switch:has(input[aria-label="提问待答收件箱通知"])').click()
    await expect(saveBtn).toBeEnabled()
  })

  test('Electron 系统通知开关回填服务端值并可保存（仅 Electron 渲染）', async ({ page }) => {
    let savedPayload: Record<string, unknown> | null = null
    await mockInboxApi(page, {
      items: [record({ id: 1 })],
      unreadCount: 1,
      preference: {
        taskCompletedEnabled: true,
        questionPendingEnabled: true,
        approvalPendingEnabled: true,
        subagentDoneEnabled: false,
        systemNotifyEnabled: false,
      },
      electron: true,
    })
    // 后注册的路由优先命中，这里覆盖 preferences 的 PUT 以捕获保存载荷
    await page.route('**/api/v1/inbox/preferences', async route => {
      if (route.request().method() === 'PUT') {
        savedPayload = route.request().postDataJSON()
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data: savedPayload ?? {
          taskCompletedEnabled: true,
          questionPendingEnabled: true,
          approvalPendingEnabled: true,
          subagentDoneEnabled: false,
          systemNotifyEnabled: false,
        } }),
      })
    })

    await page.goto('/settings/notifications')
    await expect(page.getByRole('heading', { name: '消息通知' })).toBeVisible({ timeout: 10_000 })
    const section = page.locator('.inbox-section')
    await expect(section).toBeVisible()

    // 回填服务端 false：v-model 必须绑 systemNotifyEnabled（契约字段），
    // 绑错会停留在 undefined 的中间态且 inboxDirty 恒 false
    const notifySwitch = section.getByRole('switch', { name: 'Electron 系统通知' })
    await expect(notifySwitch).toHaveAttribute('aria-checked', 'false')

    const saveBtn = section.getByRole('button', { name: '保存收件箱设置' })
    await expect(saveBtn).toBeDisabled()
    // el-switch 的可见可点区域是包裹隐藏 input 的 .el-switch 容器
    await section.locator('.el-switch:has(input[aria-label="Electron 系统通知"])').click()
    await expect(notifySwitch).toHaveAttribute('aria-checked', 'true')
    await expect(saveBtn).toBeEnabled()

    await saveBtn.click()
    await expect.poll(() => savedPayload).toMatchObject({
      systemNotifyEnabled: true,
      taskCompletedEnabled: true,
      subagentDoneEnabled: false,
    })
  })
})
