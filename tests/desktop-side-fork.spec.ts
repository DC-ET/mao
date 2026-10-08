import { test, expect, type Page } from '@playwright/test'

/**
 * 边路任务 fork（任意深度）桌面端用例：
 * ① 检查器平铺主会话全部后代边路任务（recursive 口径，含深层）；
 * ② 深层边路任务 Tab 内具备与主会话一致的 fork 入口（每轮 fork 按钮 + 「+ 边路任务」），
 *    且占位继承单选文案按来源动态化为「来源会话」；
 * ③ 搜索命中深层边路会话时按 rootSessionId 跳转根主会话并打开 Tab。
 * 全量 API mock，不依赖真实后端与 LLM。
 */

const MAIN_SESSION = {
  id: 1,
  userId: 7,
  title: '主任务',
  agentId: 9,
  executionMode: 'CLOUD',
  workspace: '/tmp/ws',
  permissionLevel: 'READ_ONLY',
  phase: 'IDLE',
  status: 'ACTIVE',
  projectKey: 'demo',
  sessionType: 'NORMAL',
}

// recursive 口径：直接子级（parent=1）与深层后代（parent=20）平铺返回
const SIDE_TASKS_RECURSIVE = [
  {
    id: 20,
    title: '直连边路',
    modelId: 1,
    parentSessionId: 1,
    permissionLevel: 'READ_ONLY',
    phase: 'COMPLETED',
    createdAt: '2026-10-06T09:00',
    updatedAt: '2026-10-06T09:30',
    unread: false,
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
  },
  {
    id: 30,
    title: '深层边路',
    modelId: 1,
    parentSessionId: 20,
    permissionLevel: 'READ_WRITE',
    phase: 'RUNNING',
    createdAt: '2026-10-06T09:10',
    updatedAt: '2026-10-06T09:40',
    unread: true,
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
  },
]

const MESSAGES_OF_SIDE_30 = {
  messages: [
    { id: 101, sessionId: 30, role: 'USER', content: '先整理背景', createdAt: '2026-10-06 09:10:00' },
    { id: 102, sessionId: 30, role: 'ASSISTANT', content: '好的，背景已整理完毕', createdAt: '2026-10-06 09:11:00' },
  ],
  hasMore: false,
  nextBeforeMessageId: null,
}

// 搜索命中深层边路会话：parent 是边路 20，根主会话是 1
const DEEP_SEARCH_RESULT = {
  items: [
    {
      id: 30,
      title: '深层边路',
      sessionType: 'SIDE_TASK',
      parentSessionId: 20,
      rootSessionId: 1,
      updatedAt: '2026-10-06T09:40',
      phase: 'RUNNING',
      agentName: 'Coder',
      snippet: '……深层任务关键词……',
    },
  ],
}

// fork 预览：边路占位 Tab 选中 Fork 时按同口径预演将复制过来的历史（切点/轮次分页）
const FORK_PREVIEW_OF_1 = {
  messages: [
    { id: 11, sessionId: 1, role: 'USER', content: '第一轮提问', createdAt: '2026-10-06 09:00:00' },
    { id: 12, sessionId: 1, role: 'ASSISTANT', content: '第一轮回答', createdAt: '2026-10-06 09:01:00' },
  ],
  hasMore: false,
  nextBeforeMessageId: null,
  compactionEvents: [],
}

async function mockLoggedInDesktopApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname
    let data: unknown = null
    if (p.endsWith('/users/me')) {
      data = { id: 1, username: 'admin', displayName: 'Admin' }
    } else if (p.endsWith('/auth/features')) {
      data = { feishuEnabled: false }
    } else if (p.endsWith('/sessions/search')) {
      data = DEEP_SEARCH_RESULT
    } else if (p.endsWith('/sessions/groups')) {
      data = { groups: [] }
    } else if (p.endsWith('/sessions/1/side-tasks')) {
      data = SIDE_TASKS_RECURSIVE
    } else if (/\/sessions\/\d+\/side-tasks$/.test(p)) {
      data = []
    } else if (/\/sessions\/\d+\/fork-preview$/.test(p)) {
      data = p.startsWith('/api/v1/sessions/1/') ? FORK_PREVIEW_OF_1 : { messages: [], hasMore: false, nextBeforeMessageId: null, compactionEvents: [] }
    } else if (/\/sessions\/\d+\/messages$/.test(p)) {
      data = p.endsWith('/sessions/30/messages') ? MESSAGES_OF_SIDE_30 : { messages: [], hasMore: false, nextBeforeMessageId: null }
    } else if (/\/sessions\/\d+\/queue$/.test(p)) {
      data = []
    } else if (p.endsWith('/sessions/1')) {
      data = MAIN_SESSION
    } else if (/\/sessions\/\d+$/.test(p)) {
      data = { id: Number(p.split('/').pop()), title: '边路任务', phase: 'COMPLETED', sessionType: 'SIDE_TASK', permissionLevel: 'READ_WRITE', modelId: 7 }
    } else if (p.endsWith('/models/active')) {
      data = []
    } else if (p.endsWith('/models/default')) {
      data = { id: 1, name: 'Default Model' }
    } else if (/\/agents\/\d+$/.test(p)) {
      data = { id: 9, name: 'Coder' }
    } else if (p.endsWith('/agents')) {
      data = []
    } else if (p.includes('/sessions/')) {
      data = {}
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, message: 'success', data })
    })
  })
}

test.describe('Desktop - side fork (任意深度)', () => {
  test('检查器平铺展示主会话全部后代边路任务', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/tasks/1')
    // 直接子级与深层后代同列表平铺（无层级区分）
    await expect(page.locator('.side-task-item').filter({ hasText: '直连边路' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.side-task-item').filter({ hasText: '深层边路' })).toBeVisible()
    await expect(page.locator('.side-task-item')).toHaveCount(2)
  })

  test('深层边路任务 Tab 内开放 fork 入口且继承文案动态化', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/tasks/1')
    // 从检查器打开深层任务 Tab
    await page.locator('.side-task-item').filter({ hasText: '深层边路' }).click()
    await expect(page.locator('.center-tab-bar .tab-item').filter({ hasText: '深层边路' }))
      .toBeVisible({ timeout: 8_000 })
    // 与主会话一致的入口：每轮 fork 按钮（assistant 气泡）
    await expect(page.locator('.fork-btn').first()).toBeVisible({ timeout: 8_000 })
    // 与主会话一致的入口：窗口右下角「+ 边路任务」
    await expect(page.locator('.side-task-btn')).toBeVisible()

    // 点击「+ 边路任务」：来源为深层边路会话 → 占位 Tab 继承单选文案是「来源会话」而非「主会话」
    await page.locator('.side-task-btn').click()
    await expect(page.locator('.inherit-bar')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('.inherit-bar')).toContainText('不继承')
    await expect(page.locator('.inherit-bar')).toContainText('来源会话摘要')
    await expect(page.locator('.inherit-bar')).toContainText('Fork 来源会话')
    await expect(page.locator('.inherit-bar')).not.toContainText('主会话摘要')
  })

  test('选中 Fork 时占位 Tab 预览将复制过来的历史消息', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/tasks/1')
    await page.locator('.side-task-btn').first().click()
    await expect(page.locator('.inherit-bar')).toBeVisible({ timeout: 8_000 })

    // 未选中 Fork 时不发预览请求，也没有预览提示条
    await expect(page.locator('.fork-preview-banner')).toHaveCount(0)

    await page.locator('.inherit-bar').getByText('Fork 主会话').click()
    // 预览提示条 + 来源主会话的历史消息直接上屏（轮次折叠渲染）
    await expect(page.locator('.fork-preview-banner')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('.fork-preview-banner')).toContainText('Fork 预览')
    await expect(page.locator('.message-bubble.user').filter({ hasText: '第一轮提问' })).toBeVisible()
    await expect(page.locator('.message-bubble.assistant').filter({ hasText: '第一轮回答' })).toBeVisible()

    // 渲染与真实 fork 会话一致：每轮助手回复仍带 fork 按钮（可从预览直接换个切点再分叉）
    await expect(page.locator('.side-chat-panel .fork-btn')).toHaveCount(1)

    // 切回不继承：预览请求与提示条一起消失
    await page.locator('.inherit-bar').getByText('不继承').click()
    await expect(page.locator('.fork-preview-banner')).toHaveCount(0)
    await expect(page.locator('.message-bubble.user').filter({ hasText: '第一轮提问' })).toHaveCount(0)
  })

  test('搜索命中深层边路会话时跳转其根主会话', async ({ page }) => {
    await mockLoggedInDesktopApi(page)
    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    await page.locator('.search-toggle').first().click()
    await expect(page.locator('.session-search-dialog input')).toBeVisible({ timeout: 5_000 })
    await page.locator('.session-search-dialog input').fill('关键词')
    await expect(page.locator('.search-result-item')).toHaveCount(1)
    await page.locator('.search-result-item').first().click()
    // 跳根主会话 1（若误用 parentSessionId 会落到 /tasks/20）
    await expect(page).toHaveURL(/\/tasks\/1$/, { timeout: 8_000 })
    await expect(page.locator('.center-tab-bar .tab-item').filter({ hasText: '深层边路' }))
      .toBeVisible({ timeout: 8_000 })
  })
})
