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
    if (path === '/agents') return fulfill(agentFound ? [AGENT] : [])
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
    if (path.endsWith('/side-tasks') || path.endsWith('/subagents')) return fulfill([])
    return fulfill(null)
  })
}

async function openSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'test-access-token')
  })
  await page.goto('/tasks/101')
  await expect(page.locator('.session-agent-bar')).toBeVisible({ timeout: 15_000 })
}

test.describe('Desktop - 会话 Agent 身份可见性', () => {
  test('顶部身份条、工具条徽标与右栏分区显示同一 Agent', async ({ page }) => {
    await mockApis(page)
    await openSession(page)

    const bar = page.locator('.session-agent-bar')
    await expect(bar.locator('.bar-name')).toHaveText(AGENT_NAME)
    await expect(bar.locator('.bar-desc')).toHaveText(AGENT_DESC)

    // 工具条只读徽标（桌面：头像 + 名称）
    const toolbarAgent = page.locator('.toolbar-agent')
    await expect(toolbarAgent).toBeVisible()
    await expect(toolbarAgent).toHaveAttribute('title', `当前智能体：${AGENT_NAME}`)
    await expect(toolbarAgent.locator('.agent-badge-name')).toHaveText(AGENT_NAME)

    // 右栏「智能体」独立分区
    const agentSection = page.locator('.agent-section')
    await expect(agentSection).toBeVisible()
    await expect(agentSection.locator('.section-title')).toHaveText('智能体')
    await expect(agentSection.locator('.agent-badge-name')).toHaveText(AGENT_NAME)
    await expect(agentSection.locator('.agent-badge-desc')).toHaveText(AGENT_DESC)

    // 「查看智能体」入口不报错，右栏分区保持可见
    await bar.locator('.bar-detail').click()
    await expect(agentSection).toBeVisible()

    // 工作区分区不再重复展示 Agent 名
    await expect(page.locator('.task-workspace-row .workspace-path', { hasText: AGENT_NAME })).toHaveCount(0)
  })

  test('Agent 已停用或不可见时名称回退并给出标记', async ({ page }) => {
    await mockApis(page, { agentId: 8, agentName: '已停用的助手', agentFound: false })
    await openSession(page)

    await expect(page.locator('.session-agent-bar .bar-name')).toHaveText('已停用的助手')
    await expect(page.locator('.session-agent-bar .bar-hint')).toHaveText('已停用或不可见')
  })

  test('移动端身份条隐藏描述，工具条只保留头像', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await mockApis(page)
    await openSession(page)

    await expect(page.locator('.session-agent-bar .bar-name')).toHaveText(AGENT_NAME)
    await expect(page.locator('.session-agent-bar .bar-desc')).toBeHidden()
    await expect(page.locator('.session-agent-bar .detail-short')).toBeVisible()

    const toolbarAgent = page.locator('.toolbar-agent')
    await expect(toolbarAgent.locator('.agent-badge-name')).toHaveCount(0)
    await expect(toolbarAgent.locator('.agent-avatar')).toBeVisible()
  })
})
