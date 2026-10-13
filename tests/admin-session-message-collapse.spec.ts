import { test, expect, type Page } from '@playwright/test'

/**
 * 会话详情「用户消息」折叠判定：必须按**实际渲染行数**，而不是源码字符数。
 * 回归案例（session 805「配置活动ID到Apollo」）：161 字符、5 个换行的消息，
 * 宽屏一行放得下不折叠，手机窄屏折成十几行 —— 旧实现按「换行 > 10 或字符 > 800」判定，
 * 判定为「不用折叠」于是不渲染展开按钮，但 CSS 仍把它 clamp 在 10 行，用户看不到后半句。
 */

const iso = '2026-10-13T18:12:54+08:00'

const SHORT_MESSAGE = '帮我看看这个配置'

// 长且多行：桌面上也应超过 10 行，必须折叠并提供展开入口
const LONG_MESSAGE = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：这是一条很长的用户消息内容。`).join('\n')

// 线上真实案例：字符数（161）远小于旧阈值 800，窄屏才会折成 10 行以上
const NARROW_SCREEN_CASE = [
  '【群内最近消息】',
  '[2026-10-13 18:11] 马方超：这是改激励活动apollo的话题',
  '',
  '【用户消息】',
  '马方超：@梁子 2151这个活动id给我配置到线上dealer- activity的apollo配置：reward.center.filter.activity  中去，运营需要该活动不展示在用户的奖励中心中',
].join('\n')

const USER_CONTENTS = [SHORT_MESSAGE, LONG_MESSAGE, NARROW_SCREEN_CASE]

interface BubbleMeasure {
  text: string
  hasToggle: boolean
  clamped: boolean
  naturalHeight: number
  visibleHeight: number
}

/** 页面内独立测量：撤掉 clamp 量自然高度，再还原；同时读取是否渲染了展开按钮 */
async function probeUserBubbles(page: Page): Promise<BubbleMeasure[]> {
  return page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('.message-item.user .user-text'))
    return bubbles.map((el) => {
      const content = el.querySelector('.user-text-content') as HTMLElement | null
      if (content == null) return { text: '', hasToggle: false, clamped: false, naturalHeight: 0, visibleHeight: 0 }
      const prevDisplay = content.style.display
      const prevClamp = content.style.webkitLineClamp
      content.style.display = 'block'
      content.style.webkitLineClamp = 'none'
      const naturalHeight = content.scrollHeight
      content.style.display = prevDisplay
      content.style.webkitLineClamp = prevClamp
      return {
        text: content.textContent ?? '',
        hasToggle: el.querySelector('.user-collapse-toggle') != null,
        clamped: el.classList.contains('collapsed'),
        naturalHeight,
        visibleHeight: content.clientHeight,
      }
    })
  })
}

function bubbleOf(bubbles: BubbleMeasure[], content: string): BubbleMeasure {
  const hit = bubbles.find((b) => b.text === content)
  expect(hit, `未找到内容为「${content.slice(0, 20)}…」的用户消息气泡`).toBeTruthy()
  return hit as BubbleMeasure
}

async function setup(page: Page): Promise<void> {
  const session = {
    id: 7, title: '折叠测试会话', userName: '测试用户', agentName: '测试 Agent',
    phase: 'COMPLETED', executionMode: 'CLOUD',
    createdAt: iso, lastActivityAt: iso, updatedAt: iso,
  }
  const messages = USER_CONTENTS.flatMap((content, idx) => [
    { id: idx * 2 + 1, role: 'user', content, createdAt: iso },
    { id: idx * 2 + 2, role: 'assistant', content: `回复 ${idx + 1}`, createdAt: iso },
  ])
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = []
    if (path.endsWith('/auth/admin/login') || path.endsWith('/auth/login')) data = { accessToken: 'test-token', refreshToken: 'test-refresh' }
    else if (path.endsWith('/users/me')) data = { id: 1, username: 'admin', isAdmin: true, permissions: ['analytics:read', 'session:read', 'user:read', 'agent:read'] }
    else if (path.endsWith('/admin/sessions/7/messages')) data = { messages, hasMore: false }
    else if (path.endsWith('/admin/sessions/7')) data = session
    else if (path.endsWith('/admin/sessions')) data = { records: [session], total: 1 }
    await route.fulfill({ json: { code: 0, message: 'ok', data } })
  })
  await page.goto('/admin/login')
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', 'admin123')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/admin\/analytics/)
  await page.goto('/admin/sessions/7')
  await expect(page.locator('.message-item.user .user-text')).toHaveCount(USER_CONTENTS.length)
}

test.describe('会话详情用户消息折叠（宽屏）', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('宽屏放得下就不折叠，超 10 行必须给展开入口', async ({ page }) => {
    await setup(page)
    const bubbles = await probeUserBubbles(page)
    expect(bubbles).toHaveLength(3)

    const short = bubbleOf(bubbles, SHORT_MESSAGE)
    expect(short.hasToggle, '短消息不应出现展开按钮').toBe(false)
    expect(short.clamped, '短消息不应处于折叠态').toBe(false)
    expect(short.visibleHeight).toBeGreaterThanOrEqual(short.naturalHeight - 1)

    const long = bubbleOf(bubbles, LONG_MESSAGE)
    expect(long.hasToggle, '宽屏下超 10 行的长消息必须有展开按钮').toBe(true)
    expect(long.clamped).toBe(true)
    expect(long.naturalHeight).toBeGreaterThan(long.visibleHeight)

    // 不变量：任何气泡都不允许「被裁掉又没有展开入口」
    for (const bubble of bubbles) {
      expect(
        bubble.hasToggle || bubble.visibleHeight >= bubble.naturalHeight - 1,
        `气泡「${bubble.text.slice(0, 20)}…」被折叠却没有展开入口`,
      ).toBe(true)
    }
  })
})

test.describe('会话详情用户消息折叠（手机窄屏）', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('窄屏折行超过 10 行的短消息也要折叠且能展开', async ({ page }) => {
    await setup(page)
    const bubbles = await probeUserBubbles(page)

    // 161 字符、5 个换行的真实案例：窄屏折行后超过 10 行
    const narrowCase = bubbleOf(bubbles, NARROW_SCREEN_CASE)
    expect(narrowCase.naturalHeight, '用例前提：窄屏下该消息折行超过可见高度').toBeGreaterThan(narrowCase.visibleHeight)
    expect(narrowCase.hasToggle, '窄屏被裁的消息必须有展开入口').toBe(true)
    expect(narrowCase.clamped).toBe(true)

    const bubble = page.locator('.message-item.user .user-text').filter({ hasText: 'reward.center.filter.activity' })
    await bubble.getByRole('button', { name: '展开全部' }).click()
    await expect(bubble.getByRole('button', { name: '收起' })).toBeVisible()
    const expanded = await probeUserBubbles(page)
    const afterExpand = bubbleOf(expanded, NARROW_SCREEN_CASE)
    expect(afterExpand.clamped, '展开后不应再处于折叠态').toBe(false)
    expect(afterExpand.visibleHeight, '展开后应完整显示内容').toBeGreaterThanOrEqual(afterExpand.naturalHeight - 1)

    for (const item of expanded) {
      expect(
        item.hasToggle || item.visibleHeight >= item.naturalHeight - 1,
        `气泡「${item.text.slice(0, 20)}…」被折叠却没有展开入口`,
      ).toBe(true)
    }
  })
})
