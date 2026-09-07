import { test, expect, type Page } from '@playwright/test'
import { formatDateTime, formatDateTimeColumn } from '../admin/src/utils/datetime'

test('日期格式化遵循北京时间、秒精度及空值约定', () => {
  for (const value of ['2026-09-07 09:05:03', '2026-09-07T09:05:03', '2026-09-07T01:05:03.123Z', '2026-09-07T09:05:03.123456+08:00']) {
    expect(formatDateTime(value)).toBe('2026-09-07 09:05:03')
  }
  expect(formatDateTime('2026-09-07T09:05')).toBe('2026-09-07 09:05:00')
  expect(formatDateTime('2026-09-07 09:05')).toBe('2026-09-07 09:05:00')
  expect(formatDateTime('2026-09-06T16:00:00Z')).toBe('2026-09-07 00:00:00')
  expect(formatDateTime('2025-12-31T20:00:00-04:00')).toBe('2026-01-01 08:00:00')
  expect(formatDateTime('2024-02-29 00:00:00')).toBe('2024-02-29 00:00:00')
  for (const value of [null, undefined, '']) expect(formatDateTime(value)).toBe('-')
  for (const value of ['bad-date', '2026-02-29 00:00:00', '2026-13-01 00:00:00', '2026-01-01 24:00:00', {}, 0]) {
    expect(formatDateTime(value)).toBe('无效时间')
  }
  expect(formatDateTimeColumn({}, {}, '2026-09-07T01:05:03Z')).toBe('2026-09-07 09:05:03')
})

const iso = '2026-09-07T01:05:03.123Z'
const formatted = '2026-09-07 09:05:03'

async function setup(page: Page) {
  const session = { id: 7, title: '时间测试会话', userName: '测试用户', agentName: '时间 Agent', phase: 'COMPLETED', executionMode: 'CLOUD', createdAt: iso, lastActivityAt: iso, updatedAt: iso }
  const agent = { id: 7, name: '时间 Agent', createdAt: iso }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/login')) data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', isAdmin: true, permissions: ['user:read', 'agent:read', 'agent:write', 'session:read'] }
    else if (path.endsWith('/admin/sessions/7/messages')) data = { messages: [
      { id: 1, role: 'user', content: '测试问题', createdAt: iso },
      { id: 2, role: 'assistant', content: '测试回复', createdAt: iso }
    ], hasMore: false }
    else if (path.endsWith('/admin/sessions/7')) data = { ...session, lastActivityAt: null }
    else if (path.endsWith('/admin/sessions') || path.endsWith('/admin/runtime/sessions')) data = { records: [session], total: 1 }
    else if (path.endsWith('/users')) data = { records: [{ id: 2, username: '测试用户', authSource: 'LOCAL', status: 1, createdAt: iso, lastLoginAt: null }], total: 1 }
    else if (path.endsWith('/prompt-versions')) data = [{ id: 1, version: 1, systemPrompt: '提示词', createdAt: iso }]
    else if (path.endsWith('/agents')) data = [agent]
    else if (path.endsWith('/audit/logs')) data = { records: [{ id: 1, createdAt: iso, action: 'CREATE', success: 1 }], total: 1 }
    else if (path.endsWith('/scheduled-tasks/all')) data = { records: [{ id: 1, name: '时间任务', userId: 1, agentId: 7, status: 'ACTIVE', createdAt: iso, lastFireTime: null, nextFireTime: iso, finished: true, finishedAt: iso }], total: 1 }
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/dashboard/)
}

test.describe('后台时间展示', () => {
  test.use({ timezoneId: 'America/Los_Angeles' })

  test.beforeEach(async ({ page }) => { await setup(page) })

  for (const [path, count] of [['sessions', 2], ['users', 1], ['agents', 1], ['runtime', 1], ['audit-logs', 1], ['scheduled-tasks', 2]] as const) {
    test(`${path} 表格时间已格式化`, async ({ page }) => {
      await page.goto(`/admin/${path}`)
      const rows = page.locator('.el-table__body-wrapper')
      await expect(rows.getByText(formatted, { exact: true })).toHaveCount(count)
      await expect(rows).not.toContainText(iso)
      if (path === 'users' || path === 'scheduled-tasks') await expect(rows.getByText('-', { exact: true }).first()).toBeVisible()
      if (path === 'scheduled-tasks') await expect(rows.locator('.el-tag', { hasText: '已完结' })).toHaveAttribute('title', `完结于 ${formatted}`)
      if (path === 'agents') {
        await page.getByRole('button', { name: '提示词版本', exact: true }).click()
        await expect(page.getByRole('dialog').getByText(formatted, { exact: true })).toBeVisible()
      }
    })
  }

  test('会话详情与双方消息时间已格式化，保留最后活动的更新时间取值', async ({ page }) => {
    await page.goto('/admin/sessions/7')
    await expect(page.locator('.info-card').getByText(formatted, { exact: true })).toHaveCount(2)
    await expect(page.locator('.message-time').getByText(formatted, { exact: true })).toHaveCount(2)
  })

  for (const path of ['sessions', 'runtime', 'audit-logs', 'scheduled-tasks']) {
    test(`${path} 移动卡片时间已格式化`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/admin/${path}`)
      await expect(page.locator('.mobile-card-list').getByText(formatted, { exact: true })).toBeVisible()
      await expect(page.locator('.mobile-card-list')).not.toContainText(iso)
    })
  }
})
