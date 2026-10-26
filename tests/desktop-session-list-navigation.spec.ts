import { test, expect, type Page } from '@playwright/test'

/**
 * 会话列表与长会话导航（技术方案 2026-10-26-session-list-navigation-technical-design）：
 * P1 标题过滤 / P2 多选批量归档 / P3 轮次目录与只看回复。
 *
 * 全部接口页面级 mock（desktop-visual project），不连隔离后端：只校验交互闭环，
 * 服务端口径（keyword 参数、ARCHIVED 过滤、排序）由 backend-ts 单测覆盖。
 * 与 desktop.spec.ts 的 mockLoggedInDesktopApi 不共享：那里的 /sessions/groups 固定返空，
 * 扩它会影响既有搜索/定位用例；本文件自给自足，且批量归档全程 mock，不写种子库。
 */

const SESSION_ID = '101'

interface SessionFixture {
  id: number
  title: string
  summary: string
  agentId: number
  agentName: string
  executionMode: string
  status: string
  phase: string
  messageCount: number
  elapsedMs: number
  running: boolean
  workspace: string
  projectKey: string
  createdAt: string
  updatedAt: string
}

function sessionFixture(id: string, title: string, phase = 'COMPLETED'): SessionFixture {
  return {
    id: Number(id),
    title,
    summary: title,
    agentId: 1,
    agentName: '默认 Agent',
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    phase,
    messageCount: 4,
    elapsedMs: 0,
    running: phase === 'RUNNING',
    workspace: '',
    projectKey: '',
    createdAt: '2026-10-20T10:00:00',
    updatedAt: '2026-10-20T10:00:00',
  }
}

/** 标准模式三条会话：两条已完成（可批量归档）、一条运行中（必须被跳过）。 */
const STANDARD_SESSIONS: SessionFixture[] = [
  sessionFixture('101', '重构登录流程'),
  sessionFixture('102', '修复登录 500 报错'),
  sessionFixture('103', '跑批回归验证', 'RUNNING'),
]

/** 三段历史：轮1 带工具步骤、轮2 回复内嵌工具、轮3 纯文字。 */
function chatMessages(): Array<Record<string, unknown>> {
  return [
    { id: 1, role: 'user', content: '帮我重构登录流程', createdAt: '2026-10-20T10:00:00' },
    { id: 2, role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'login.ts' }, status: 'success' }], createdAt: '2026-10-20T10:00:05' },
    { id: 3, role: 'tool', toolCallId: 'tc1', content: 'const login = () => {}', createdAt: '2026-10-20T10:00:06' },
    { id: 4, role: 'assistant', content: '第一轮完成：已读取登录模块', createdAt: '2026-10-20T10:00:10' },
    { id: 5, role: 'user', content: '把单元测试也补上', createdAt: '2026-10-20T10:01:00' },
    { id: 6, role: 'assistant', content: '第二轮完成：测试已补齐', toolCalls: [{ id: 'tc2', name: 'run_tests', input: {}, status: 'success' }], createdAt: '2026-10-20T10:01:10' },
    { id: 7, role: 'user', content: '跑一下全量回归', createdAt: '2026-10-20T10:02:00' },
    { id: 8, role: 'assistant', content: '第三轮完成：回归全部通过', createdAt: '2026-10-20T10:02:10' },
  ]
}

interface MockOptions {
  /** 记录服务端实际收到的 keyword（解码后），用于验证三条 fetch 路径统一带上 */
  keywordLog?: string[]
  /** 已归档会话 id 集合：PUT /archive 写入，/sessions/groups?status=ARCHIVED 读出 */
  archived?: Set<string>
}

async function mockApi(page: Page, options: MockOptions = {}) {
  const { keywordLog, archived } = options
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const params = url.searchParams
    const method = route.request().method()
    const fulfill = (data: unknown) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, message: 'success', data }),
    })

    if (path.endsWith('/auth/features')) return fulfill({ feishuEnabled: false })
    if (path.endsWith('/users/me')) return fulfill({ id: 1, username: 'admin', displayName: 'Admin' })
    if (path === '/api/v1/sessions/groups') {
      // 服务端口径模拟：keyword 走 title LIKE，status=ARCHIVED 只回归档桶
      if (params.get('status') === 'ARCHIVED') {
        const sessions = STANDARD_SESSIONS.filter(s => archived?.has(String(s.id)))
        return fulfill(sessions.length > 0
          ? { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: sessions.length, hasMore: false, sessions }] }
          : { groups: [] })
      }
      const keyword = params.get('keyword') || ''
      if (keyword) keywordLog?.push(keyword)
      const matched = STANDARD_SESSIONS.filter(s => s.title.includes(keyword))
      return fulfill(matched.length > 0
        ? { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: matched.length, hasMore: false, sessions: matched }] }
        : { groups: [] })
    }
    const archiveMatch = path.match(/^\/api\/v1\/sessions\/(\d+)\/archive$/)
    if (archiveMatch && method === 'PUT') {
      archived?.add(archiveMatch[1])
      return fulfill(null)
    }
    if (path === '/api/v1/sessions') return fulfill([])
    if (path === '/api/v1/sessions/search') return fulfill({ items: [], total: 0, page: 1, size: 20 })
    if (path === '/api/v1/models/default') return fulfill({ id: 1, name: 'Default Model' })
    if (path === '/api/v1/agents') return fulfill([])
    if (path === `/api/v1/sessions/${SESSION_ID}`) return fulfill(sessionFixture(SESSION_ID, '重构登录流程'))
    if (path === `/api/v1/sessions/${SESSION_ID}/messages`) {
      return fulfill({ messages: chatMessages(), hasMore: false, nextBeforeMessageId: null, compactionEvents: [] })
    }
    if (path === `/api/v1/sessions/${SESSION_ID}/todos`) return fulfill([])
    if (path.endsWith('/side-tasks') || path.endsWith('/subagents')) return fulfill([])
    return fulfill(null)
  })
}

async function openTaskPanel(page: Page) {
  await page.goto('/')
  await expect(page.locator('.task-index-panel')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.session-group .session-item')).toHaveCount(3)
}

async function openChatPanel(page: Page) {
  await page.goto(`/tasks/${SESSION_ID}`)
  await expect(page.locator('.chat-panel')).toBeVisible({ timeout: 15_000 })
}

test.describe('Desktop - 会话列表标题过滤', () => {
  test('输入关键字后按 keyword 重新拉取分组，清空即还原', async ({ page }) => {
    const keywordLog: string[] = []
    await mockApi(page, { keywordLog })
    await openTaskPanel(page)

    await page.locator('.filter-toggle-btn').click()
    await expect(page.locator('.panel-filter-input')).toBeFocused()

    await page.locator('.panel-filter-input').fill('重构')
    // 300ms 防抖后重新拉取：服务端只回匹配的一条
    await expect(page.locator('.session-group .session-item')).toHaveCount(1)
    await expect(page.locator('.session-group .session-title')).toHaveText('重构登录流程')
    // 图标进入 active 态（过滤生效的可见反馈）
    await expect(page.locator('.filter-toggle-btn')).toHaveClass(/active/)
    expect(keywordLog).toContain('重构')

    // 清空：还原全部三条，且不带 keyword 再拉一次
    await page.locator('.panel-filter-clear').click()
    await expect(page.locator('.session-group .session-item')).toHaveCount(3)
    await expect(page.locator('.filter-toggle-btn')).not.toHaveClass(/active/)
  })

  test('无匹配时显示专属空态文案', async ({ page }) => {
    await mockApi(page)
    await openTaskPanel(page)

    await page.locator('.filter-toggle-btn').click()
    await page.locator('.panel-filter-input').fill('不存在的关键字')
    await expect(page.locator('.session-group .session-item')).toHaveCount(0)
    // 空态用专属文案（TaskSessionGroupList.emptyHint 的 filterActive 分支）
    await expect(page.locator('.task-index-panel .panel-empty')).toHaveText('没有匹配的任务')
  })
})

test.describe('Desktop - 多选批量归档', () => {
  test('运行中任务自动跳过，成功者迁入已归档区', async ({ page }) => {
    const archived = new Set<string>()
    await mockApi(page, { archived })
    await openTaskPanel(page)

    // 先展开已归档区：触发 archivedLoaded，归档后 store 才会自动静默刷新归档桶
    await page.locator('.archive-section .group-header').click()
    await expect(page.locator('.archive-item')).toHaveCount(0)

    await page.locator('.select-toggle-btn').click()
    await expect(page.locator('.select-action-bar')).toBeVisible()

    // 运行中的会话复选框禁用（与 archiveSessions 的 targets 过滤同口径）
    const runningRow = page.locator('.session-group .session-item', { hasText: '跑批回归验证' })
    await expect(runningRow.locator('.session-select-checkbox')).toBeDisabled()
    // 点行也不会选中它
    await runningRow.click()
    await expect(page.locator('.select-count')).toHaveText('已选 0')

    // 勾选两条已完成
    await page.locator('.session-group .session-item', { hasText: '重构登录流程' }).click()
    await page.locator('.session-group .session-item', { hasText: '修复登录 500 报错' }).click()
    await expect(page.locator('.select-count')).toHaveText('已选 2')

    await page.locator('.select-archive-btn').click()
    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText('运行中的任务将自动跳过')
    // 按按钮文案点，不依赖按钮 DOM 顺序；scope 到弹窗，避免误点操作条上同名按钮
    await box.getByRole('button', { name: '归档' }).click()

    // 两条成功入库，运行中原位保留
    await expect(page.locator('.el-message__content')).toHaveText('已归档 2 个')
    await expect(page.locator('.session-group .session-item')).toHaveCount(1)
    await expect(page.locator('.session-group .session-item')).toContainText('跑批回归验证')
    await expect(page.locator('.archive-item')).toHaveCount(2)
    // 归档区顺序由服务端排序决定（mock 按STANDARD_SESSIONS 序返回），这里只校验两条都在
    await expect(page.locator('.archive-item').filter({ hasText: '重构登录流程' })).toHaveCount(1)
    await expect(page.locator('.archive-item').filter({ hasText: '修复登录 500 报错' })).toHaveCount(1)
    // 选择模式随归档完成退出
    await expect(page.locator('.select-action-bar')).toHaveCount(0)
  })

  test('取消确认框不发起任何归档请求', async ({ page }) => {
    const archived = new Set<string>()
    await mockApi(page, { archived })
    await openTaskPanel(page)

    await page.locator('.select-toggle-btn').click()
    await page.locator('.session-group .session-item', { hasText: '重构登录流程' }).click()
    await page.locator('.select-archive-btn').click()
    // 点「取消」：不发起任何归档请求，选择态保留
    await page.locator('.el-message-box').getByRole('button', { name: '取消' }).click()
    await expect(page.locator('.el-message-box')).toHaveCount(0)
    await expect(page.locator('.session-group .session-item')).toHaveCount(3)
    await expect(page.locator('.select-action-bar')).toBeVisible()
    expect(archived.size).toBe(0)
  })
})

test.describe('Desktop - 长会话导航', () => {
  test('轮次目录点击行定位到该轮用户消息并高亮', async ({ page }) => {
    await mockApi(page)
    await openChatPanel(page)

    const handle = page.locator('.round-directory-handle')
    await expect(handle).toBeVisible()
    await handle.click()
    const popover = page.locator('.round-directory-popover')
    await expect(popover).toBeVisible()
    await expect(popover.locator('.round-directory-row')).toHaveCount(3)
    await expect(popover.locator('.round-directory-row').nth(1)).toContainText('把单元测试也补上')

    // 点击第二轮：定位到它的用户消息（flash 2s 自清，断言要快）
    await popover.locator('.round-directory-row').nth(1).click()
    await expect(page.locator('.message-bubble.message-locate-flash')).toHaveCount(1)
    await expect(page.locator('.message-bubble.message-locate-flash')).toContainText('把单元测试也补上')
    // 浮层点击后收起
    await expect(popover).toHaveCount(0)
  })

  test('只看回复：工具调用整段隐藏，关闭即还原', async ({ page }) => {
    await mockApi(page)
    await openChatPanel(page)

    // 展开第一轮的折叠步骤：工具步骤 + 轮2 回复内嵌工具，共两处
    await page.locator('.steps-summary').first().click()
    await expect(page.locator('.tool-call-group')).toHaveCount(2)

    const toggle = page.locator('.sticky-bar-btn')
    await expect(toggle).toContainText('只看回复')
    await toggle.click()
    await expect(toggle).toHaveClass(/active/)
    // 工具整段消失，但摘要行（已执行 N 个步骤）与回复正文仍在
    await expect(page.locator('.tool-call-group')).toHaveCount(0)
    await expect(page.locator('.steps-summary').first()).toContainText('已执行 1 个步骤')
    await expect(page.locator('.assistant-text').first()).toContainText('第一轮完成：已读取登录模块')

    await toggle.click()
    await expect(page.locator('.tool-call-group')).toHaveCount(2)
  })
})
