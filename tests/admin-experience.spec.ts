import { test, expect } from '@playwright/test'

const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin123'

/** Login helper: navigates to login, fills form, submits, waits for analytics homepage */
async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await page.waitForSelector('.login-card', { timeout: 10_000 })

  await page.fill('input[placeholder="用户名"]', ADMIN_USER)
  await page.fill('input[placeholder="密码"]', ADMIN_PASS)
  await page.getByRole('button', { name: '登录', exact: true }).click()

  await page.waitForURL(/\/admin\/analytics/, { timeout: 10_000 })
  await page.waitForSelector('.layout-container', { timeout: 10_000 })
}

const DOC_A = '---\ntitle: 经验库 e2e 文档 A\nkeywords: e2e, 验证\nsummary: 冒烟种子文档\napplicable: e2e\nlast_verified: 2026-10-24\n---\n\n## 现象\n\n种子正文一。\n'
const DOC_B = '---\ntitle: 经验库 e2e 文档 B\nkeywords: e2e\nsummary: 第二篇种子\n---\n\n种子正文二。\n'
const FILE_A = '2026-10-24-playwright-a.md'
const FILE_B = '2026-10-24-playwright-b.md'

test.describe('经验库管理页', () => {
  test('库列表、分组列表、搜索、渲染态与索引页可贯通', async ({ page, request }) => {
    await login(page)
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const auth = { Authorization: `Bearer ${token}` }

    const agentsRes = await request.get('/api/v1/agents', { headers: auth })
    const agents = await agentsRes.json()
    expect(agents.code).toBe(0)
    expect(agents.data.length).toBeGreaterThan(0)
    const agentId = agents.data[0].id as number
    const agentName = agents.data[0].name as string

    // 幂等写入两篇种子文档（同名覆盖）
    for (const [fileName, content] of [[FILE_A, DOC_A], [FILE_B, DOC_B]] as const) {
      const putRes = await request.put(`/api/v1/agents/${agentId}/experience-library/docs/content`, {
        headers: auth,
        data: { fileName, content },
      })
      expect((await putRes.json()).code).toBe(0)
    }

    try {
      await page.goto(`/admin/experience?agentId=${agentId}`)

      // 库选择器 + 统计
      await expect(page.locator('.library-bar')).toContainText(agentName)
      // 默认按月分组：两篇同月文档 + 组头计数
      await expect(page.locator('.doc-table')).toContainText(`${FILE_A}`)
      await expect(page.locator('.doc-table')).toContainText(`${FILE_B}`)
      await expect(page.locator('.group-cell').first()).toContainText('2026-10 · 2 篇')
      const headers = page.locator('.doc-table thead')
      await expect(headers).toContainText('文件名')
      await expect(headers).toContainText('关键词')
      await expect(headers).not.toContainText('标题')
      await expect(headers).not.toContainText('摘要')
      await expect(headers).not.toContainText('大小')

      // 关键词搜索：只命中 A
      await page.fill('input[aria-label="搜索经验文档"]', '文档 A')
      await page.keyboard.press('Enter')
      await expect(page.locator('.doc-table')).toContainText(FILE_A)
      await expect(page.locator('.doc-table')).not.toContainText(FILE_B)
      await expect(page.locator('.doc-table')).toContainText('1 篇')

      // 重置后恢复两篇
      await page.getByRole('button', { name: '重置' }).click()
      await expect(page.locator('.doc-table')).toContainText(FILE_B)

      // 打开文档：弹窗阅读（列表仍在）+ 元数据卡 + Markdown 渲染态
      await page.locator('.doc-table').getByText(FILE_A).first().click()
      const dialog = page.getByRole('dialog', { name: '经验库 e2e 文档 A' })
      await expect(dialog).toBeVisible()
      await expect(page.locator('.meta-card')).toContainText('冒烟种子文档')
      await expect(page.locator('.doc-content h2')).toHaveText('现象')
      await expect(page.locator('.doc-table')).toBeVisible()

      // 源码态展示原文
      await dialog.getByRole('button', { name: '源码态' }).click()
      await expect(page.locator('.source-pre')).toContainText('## 现象')

      // 阅读器工具条直达索引视图：渲染 INDEX.md（按钮 aria-label 为「查看索引」）
      await dialog.getByRole('button', { name: '查看索引' }).click()
      await expect(page.getByRole('dialog', { name: '索引 INDEX.md（系统自动生成）' })).toBeVisible()
      await expect(page.locator('.doc-viewer')).toContainText('INDEX.md 由系统自动生成')

      // 关闭弹窗回到列表
      await page.getByRole('button', { name: '关闭此对话框' }).click()
      await expect(page.locator('.doc-table')).toBeVisible()
      await expect(page.locator('.doc-viewer')).toHaveCount(0)
    } finally {
      for (const fileName of [FILE_A, FILE_B]) {
        await request.delete(`/api/v1/agents/${agentId}/experience-library/docs`, {
          headers: auth,
          params: { file: fileName },
        })
      }
    }
  })

  test('Agent 列表「经验库」入口跳转管理页并直达该 Agent', async ({ page }) => {
    await login(page)
    await page.goto('/admin/agents')
    await page.waitForSelector('.el-table')
    await page.locator('.el-table__body tr').first().getByRole('button', { name: '经验库' }).click()
    await expect(page).toHaveURL(/\/experience\?agentId=\d+/)
    await expect(page.locator('.doc-list-panel')).toBeVisible()
    await expect(page.locator('.doc-table')).toBeVisible()
  })

  test('直达 URL、行内编辑、分组切换、切库与失效 file 降级', async ({ page, request }) => {
    await login(page)
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const auth = { Authorization: `Bearer ${token}` }

    const agentsRes = await request.get('/api/v1/agents', { headers: auth })
    const agents = await agentsRes.json()
    expect(agents.code).toBe(0)
    expect(agents.data.length).toBeGreaterThan(1)
    const agentId = agents.data[0].id as number
    const otherAgentId = agents.data[1].id as number
    const otherAgentName = agents.data[1].name as string

    // agent1 播两篇；agent2 也播一篇——库目录懒创建，无文档的 Agent 不会出现在侧栏
    for (const [id, fileName, content] of [
      [agentId, FILE_A, DOC_A],
      [agentId, FILE_B, DOC_B],
      [otherAgentId, FILE_B, DOC_B],
    ] as const) {
      const putRes = await request.put(`/api/v1/agents/${id}/experience-library/docs/content`, {
        headers: auth,
        data: { fileName, content },
      })
      expect((await putRes.json()).code).toBe(0)
    }

    try {
      // 列表态先验证行内编辑（编辑在弹窗内，列表仍在后面）
      await page.goto(`/admin/experience?agentId=${agentId}`)
      await expect(page.locator('.doc-table')).toContainText(FILE_A)

      // 行内「编辑」：弹窗进编辑器且缓冲为原文
      await page.locator('.doc-table .el-table__body tr', { hasText: FILE_A }).getByRole('button', { name: '编辑' }).click()
      await expect(page.locator('.doc-viewer .editor')).toBeVisible()
      await expect(page.locator('.doc-viewer .editor textarea')).toHaveValue(DOC_A)
      await page.getByRole('button', { name: '取消' }).click()
      await expect(page.locator('.doc-viewer .editor')).toHaveCount(0)
      // 取消后停留在该文档的渲染态（弹窗仍打开）
      await expect(page.locator('.doc-content')).toBeVisible()

      // 关闭弹窗 → 分组切换（月 → 关键词）：groupCounts 随新口径刷新，行不丢失
      await page.getByRole('button', { name: '关闭此对话框' }).click()
      await expect(page.locator('.doc-table')).toBeVisible()
      await page.locator('.list-controls .el-select').first().click()
      await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '按关键词' }).click()
      await expect(page.locator('.doc-table .group-cell').first()).toContainText('e2e · 2 篇')
      await expect(page.locator('.doc-table')).toContainText(FILE_A)
      await expect(page.locator('.doc-table')).toContainText(FILE_B)

      // 切库（下拉）：列表切到另一库自己的文档，URL 无 file
      await page.locator('.library-bar .el-select').click()
      await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: otherAgentName }).click()
      await expect(page).not.toHaveURL(/file=/)
      await expect(page.locator('.doc-table')).toBeVisible()
      await expect(page.locator('.doc-table')).toContainText(FILE_B)

      // 失效 file：直达 URL 指向已删文档 → 错误 toast + URL 摘除 file + 回列表态
      const delRes = await request.delete(`/api/v1/agents/${agentId}/experience-library/docs`, {
        headers: auth,
        params: { file: FILE_B },
      })
      expect((await delRes.json()).code).toBe(0)
      await page.goto(`/admin/experience?agentId=${agentId}&file=${encodeURIComponent(FILE_B)}`)
      await expect(page.locator('.el-message--error')).toBeVisible()
      await expect(page).not.toHaveURL(/file=/)
      await expect(page.locator('.doc-table')).toBeVisible()

      // 直达有效 file：弹窗打开该文档，列表仍在
      await page.goto(`/admin/experience?agentId=${otherAgentId}&file=${encodeURIComponent(FILE_B)}`)
      await expect(page.getByRole('dialog', { name: '经验库 e2e 文档 B' })).toBeVisible()
      await expect(page.locator('.doc-table')).toBeVisible()
    } finally {
      for (const [id, fileName] of [
        [agentId, FILE_A],
        [agentId, FILE_B],
        [otherAgentId, FILE_B],
      ] as const) {
        await request.delete(`/api/v1/agents/${id}/experience-library/docs`, {
          headers: auth,
          params: { file: fileName },
        })
      }
    }
  })
})
