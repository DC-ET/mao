import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * 管理后台定时任务：详情弹窗（提示词全文）与编辑弹窗（名称/Cron/提示词/一次性开关 + Cron 预览）。
 * 全部 API 走 page.route mock，不依赖后端。
 */

const TASK = {
  id: 1,
  userId: 2,
  agentId: 7,
  sessionId: 11,
  name: '每日GMV',
  prompt: '查询昨日 GMV 总额。\n使用 bigdata-cli 技能，报告统计日期、币种与口径摘要。',
  cronExpression: '0 0 9 * * ?',
  status: 'ACTIVE',
  once: 0,
  lastFireTime: null,
  lastExecutionStatus: 'COMPLETED',
  nextFireTime: '2026-09-23 09:00:00',
  fireCount: 3,
  finished: 0,
  finishedAt: null,
  createdAt: '2026-09-01 10:00:00',
  updatedAt: '2026-09-20 10:00:00'
}

const PREVIEW_TIMES = ['2026-09-23 09:00:00', '2026-09-24 09:00:00', '2026-09-25 09:00:00']

let putBody: Record<string, unknown> | null = null

function normalizeCron(expression: string): string {
  return expression.trim().replace(/\?/g, '*').replace(/\s+/g, ' ')
}

/** 与服务端 isOneShotCron 同形：秒/分/时/日/月固定且周为通配。 */
function isOneShotCron(expression: string): boolean {
  const parts = normalizeCron(expression).split(' ')
  if (parts.length !== 6) return false
  const fixed = (p: string) => /^\d+$/.test(p)
  const any = (p: string) => p === '*'
  return fixed(parts[0]) && fixed(parts[1]) && fixed(parts[2]) && fixed(parts[3]) && fixed(parts[4]) && any(parts[5])
}

async function setup(page: Page, options: { permissions?: string[]; tasks?: typeof TASK[] } = {}) {
  const permissions = options.permissions ?? ['session:read', 'scheduled-task:write']
  const tasks = options.tasks ?? [TASK]
  putBody = null

  await page.route('**/api/v1/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    const json = (data: unknown) => route.fulfill({ json: { code: 0, message: 'ok', data } })

    if (path.endsWith('/auth/admin/login')) return json({ accessToken: 'test-token', refreshToken: 'test-refresh' })
    if (path.endsWith('/users/me')) return json({ id: 1, username: 'admin', isAdmin: true, permissions })
    if (path.endsWith('/admin/sessions/options/users')) return json([{ id: 2, username: 'zhang', displayName: '张三' }])
    if (path.endsWith('/admin/sessions/options/agents')) return json([{ id: 7, name: '数据分析' }])
    if (path.endsWith('/scheduled-tasks/all')) return json({ records: tasks, total: tasks.length })
    if (path.endsWith('/scheduled-tasks/cron-preview')) {
      const body = (route.request().postDataJSON() ?? {}) as { expression?: string }
      const expression = String(body.expression ?? '')
      if (expression.includes('bad')) {
        return json({ valid: false, oneShot: false, nextFireTimes: [], message: '无效的 cron 表达式: bad' })
      }
      return json({ valid: true, oneShot: isOneShotCron(expression), nextFireTimes: PREVIEW_TIMES, message: null })
    }
    if (/\/scheduled-tasks\/\d+$/.test(path) && method === 'PUT') {
      putBody = route.request().postDataJSON() as Record<string, unknown>
      return json({ ...tasks[0], ...putBody, nextFireTime: '2026-09-23 09:00:00' })
    }
    return json([])
  })

  await page.goto('/admin/login')
  await page.waitForSelector('.login-card')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.click('button:has-text("登录")')
  await page.waitForURL(/\/admin\/analytics/)
  await page.goto('/admin/scheduled-tasks')
  await expect(page.locator('.el-table__body-wrapper').getByText('每日GMV')).toBeVisible()
}

function cronInput(page: Page) {
  return page.getByRole('dialog').locator('input[placeholder^="秒 分 时"]')
}

test.describe('管理后台定时任务', () => {
  test('详情弹窗展示完整提示词与任务全貌', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: '查看', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('定时任务详情')
    await expect(dialog.locator('.prompt-body')).toHaveText(/查询昨日 GMV 总额。\s*使用 bigdata-cli 技能/)
    await expect(dialog).toContainText('0 0 9 * * ?')
    await expect(dialog).toContainText('2026-09-23 09:00:00')
    await expect(dialog).toContainText('数据分析')
    await expect(dialog).toContainText('张三')
  })

  test('编辑弹窗预览 Cron 并按固定字段提交', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('编辑定时任务')
    // 打开即按当前 Cron 拉一次预览
    await expect(dialog.locator('.preview-times')).toContainText('2026-09-23 09:00:00')

    await dialog.locator('.el-form-item', { hasText: '任务名称' }).locator('input').fill('每日GMV 复核')
    await dialog.locator('textarea').fill('查询昨日 GMV 总额并复核订单量。')
    await dialog.getByRole('button', { name: '保存' }).click()

    await expect.poll(() => putBody).not.toBeNull()
    expect(putBody).toMatchObject({
      name: '每日GMV 复核',
      prompt: '查询昨日 GMV 总额并复核订单量。',
      cronExpression: '0 0 9 * * ?',
      once: false
    })
    // 只提交这 4 个字段，不携带 status / user / agent 等
    expect(Object.keys(putBody ?? {}).sort()).toEqual(['cronExpression', 'name', 'once', 'prompt'])
    await expect(page.locator('.el-message--success')).toContainText('已保存')
  })

  test('改成一次性 Cron 形态时开关自动跟随，提交 once=true', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await cronInput(page).fill('0 0 8 15 8 ?')

    await expect(dialog.locator('.el-switch')).toHaveClass(/is-checked/)
    await expect(dialog.locator('.preview-times')).toContainText('一次性任务')
    await dialog.getByRole('button', { name: '保存' }).click()

    await expect.poll(() => putBody).not.toBeNull()
    expect(putBody).toMatchObject({ cronExpression: '0 0 8 15 8 ?', once: true })
  })

  test('非法 Cron 时提示错误并禁用保存', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await cronInput(page).fill('0 0 bad * * ?')

    await expect(dialog.locator('.preview-error')).toContainText('无效的 cron 表达式')
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  test('缺少 scheduled-task:write 时他人任务只读', async ({ page }) => {
    await setup(page, { permissions: ['session:read'] })

    const row = page.locator('.el-table__body-wrapper')
    await expect(row.getByRole('button', { name: '查看', exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
    await expect(row.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
    await expect(row.locator('.el-switch')).toHaveClass(/is-disabled/)
  })
})
