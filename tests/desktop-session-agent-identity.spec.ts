import { test, expect, type Page } from '@playwright/test'

/**
 * 会话 Agent 身份可见性（顶部身份条 / 工具条徽标 / 右栏分区）页面级验收。
 * 全部接口 mock，不连隔离后端：只校验渲染与降级，不校验真实数据链路。
 */

const AGENT_ID = 7
const AGENT_NAME = '文档助手'
const AGENT_DESC = '负责合同与制度问答'

const AGENT = {
  id: AGENT_ID,
  name: AGENT_NAME,
  avatarUrl: null,
  description: AGENT_DESC,
}

function mockApis(
  page: Page,
  options: { agentId?: number; agentName?: string; agentFound?: boolean } = {},
  requests: string[] = [],
): Promise<void> {
  const agentId = options.agentId ?? AGENT_ID
  const agentFound = options.agentFound ?? true

  return page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api\/v1/, '')

    const fulfill = async (data: unknown): Promise<void> => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success', data }),
      })
    }

    if (path === '/auth/features') return fulfill({ feishuEnabled: false })
    if (path === '/users/me') return fulfill({ id: 1, username: 'admin', displayName: 'Admin' })
    if (path === '/sessions/groups') return fulfill({ groups: [] })
    if (path === '/sessions/search') return fulfill({ items: [] })
    if (path === '/models/default') return fulfill({ id: 1, name: 'Default Model' })
    if (path === '/agents') {
      requests.push(url.toString())
      return fulfill(agentFound ? [AGENT] : [])
    }
    if (path === `/agents/${AGENT_ID}`) {
      if (!agentFound) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 404, message: 'agent not found', data: null }),
        })
        return
      }
      return fulfill(AGENT)
    }
    if (path === '/sessions') return fulfill([])
    if (path === '/sessions/101') {
      return fulfill({
        id: 101,
        title: '合同审查',
        agentId,
        agentName: options.agentName ?? AGENT_NAME,
        executionMode: 'CLOUD',
        workspace: '',
        projectKey: '',
        permissionLevel: 'READ_ONLY',
        phase: 'COMPLETED',
        modelId: 1,
        createdAt: '2026-10-20T10:00',
        updatedAt: '2026-10-20T10:00',
      })
    }
    if (path === '/sessions/101/messages') return fulfill({ messages: [], hasMore: false })
    if (path === '/sessions/cloud-projects') return fulfill([])
    if (path.endsWith('/side-tasks') || path.endsWith('/subagents')) return fulfill([])
    return fulfill(null)
  })
}

async function openSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.goto('/tasks/101')
  // 工具条徽标是会话内常驻身份入口（顶部横条已按产品反馈移除）
  await expect(page.locator('.toolbar-agent')).toBeVisible({ timeout: 15_000 })
}

test.describe('Desktop - 会话 Agent 身份可见性', () => {
  test('工具条徽标与右栏分区显示同一 Agent，且不再有顶部身份横条', async ({ page }) => {
    await mockApis(page)
    await openSession(page)

    // 顶部横条已移除：主会话 Agent 只出现在 Tab 图标 / 工具条徽标 / 右栏分区
    await expect(page.locator('.session-agent-bar')).toHaveCount(0)

    const toolbarAgent = page.locator('.toolbar-agent')
    await expect(toolbarAgent).toHaveAttribute('title', `当前智能体：${AGENT_NAME}`)
    await expect(toolbarAgent.locator('.agent-badge-name')).toHaveText(AGENT_NAME)

    // 右栏「智能体」独立分区
    const agentSection = page.locator('.agent-section')
    await expect(agentSection).toBeVisible()
    await expect(agentSection.locator('.section-title')).toHaveText('智能体')
    await expect(agentSection.locator('.agent-badge-name')).toHaveText(AGENT_NAME)
    await expect(agentSection.locator('.agent-badge-desc')).toHaveText(AGENT_DESC)

    // 点击徽标不报错，右栏分区保持可见
    await toolbarAgent.click()
    await expect(agentSection).toBeVisible()

    // 工作区分区不再重复展示 Agent 名
    await expect(page.locator('.task-workspace-row .workspace-path', { hasText: AGENT_NAME })).toHaveCount(0)

    // 多 Tab 时主会话 Tab 的默认图标被 Agent 头像替代
    await page.locator('.side-task-btn').click()
    await expect(page.locator('.center-tab-bar')).toBeVisible()
    const chatTab = page.locator('.tab-item', { hasText: '主会话' })
    await expect(chatTab.locator('.tab-agent-avatar')).toBeVisible()
  })

  test('Agent 已停用或不可见时名称回退并给出标记', async ({ page }) => {
    await mockApis(page, { agentId: 8, agentName: '已停用的助手', agentFound: false })
    await openSession(page)

    const toolbarAgent = page.locator('.toolbar-agent')
    await expect(toolbarAgent.locator('.agent-badge-name')).toHaveText('已停用的助手')
    await expect(toolbarAgent.locator('.agent-badge-hint')).toHaveText('已停用或不可见')
  })

  test('新建会话只拉取客户端可见的 Agent', async ({ page }) => {
    const requests: string[] = []
    await mockApis(page, {}, requests)
    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-access-token')
    })
    await page.goto('/?newTask=1')
    await expect(page.locator('.agent-chip')).toBeVisible({ timeout: 15_000 })
    expect(requests.some(url => url.includes('scope=client'))).toBe(true)
  })

  test('移动端工具条只保留头像', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await mockApis(page)
    await openSession(page)

    const toolbarAgent = page.locator('.toolbar-agent')
    await expect(toolbarAgent.locator('.agent-badge-name')).toHaveCount(0)
    await expect(toolbarAgent.locator('.agent-avatar')).toBeVisible()
    await expect(page.locator('.session-agent-bar')).toHaveCount(0)
  })
})
