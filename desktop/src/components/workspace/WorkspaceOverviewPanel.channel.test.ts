// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import WorkspaceOverviewPanel from './WorkspaceOverviewPanel.vue'

/** 机器人通道工作区展示回归（技术方案 2026-11-02）：名称合成、类别标签、群条目禁删 */

const api = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchReferences: vi.fn(),
  deleteWorkspace: vi.fn(),
  refreshOverview: vi.fn(),
}))

vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return { ...actual, ElMessage: { success: vi.fn(), error: vi.fn() } }
})

vi.mock('../../api', () => ({
  deleteWorkspaceByPath: api.deleteWorkspace,
  fetchWorkspaceOverview: api.fetchOverview,
  fetchWorkspaceReferences: api.fetchReferences,
  refreshWorkspaceOverview: api.refreshOverview,
}))

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function entry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    path: `/root/7/${name}`,
    kind: 'other',
    isGit: false,
    sizeBytes: null,
    sizeState: 'ready',
    activeSessions: 0,
    archivedSessions: 0,
    lastUsedAt: null,
    ...overrides,
  }
}

/** 飞书群工作区：leaf 为群 chatId，多人共享 */
function feishuGroup() {
  return entry('OC_67F0F76', {
    kind: 'channel',
    channel: 'feishu',
    chatType: 'group',
    accountId: 'cli_a1b2c3',
    path: '/root/feishu-chat/cli_a1b2c3/OC_67F0F76',
    lastUsedAt: '2026-11-01 10:00:00',
  })
}

/** 飞书私聊工作区：leaf 为 private-{userId}，仅本人 */
function feishuPrivate() {
  return entry('private-7', {
    kind: 'channel',
    channel: 'feishu',
    chatType: 'private',
    accountId: 'cli_a1b2c3',
    path: '/root/feishu-chat/cli_a1b2c3/private-7',
    lastUsedAt: '2026-11-01 09:00:00',
  })
}

/** 钉钉群工作区 */
function dingtalkGroup() {
  return entry('cid_group9', {
    kind: 'channel',
    channel: 'dingtalk',
    chatType: 'group',
    accountId: 'bot-9',
    path: '/root/dingtalk-chat/bot-9/cid_group9',
    lastUsedAt: '2026-11-01 08:00:00',
  })
}

const flushMacro = () => new Promise(r => setTimeout(r, 0))

describe('WorkspaceOverviewPanel 机器人通道工作区', () => {
  let host: HTMLDivElement
  let app: App

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })
    api.fetchOverview.mockReset()
    api.fetchReferences.mockReset()
    api.deleteWorkspace.mockReset()
    api.refreshOverview.mockReset()
    api.refreshOverview.mockResolvedValue(undefined)
    api.deleteWorkspace.mockResolvedValue(undefined)
    api.fetchReferences.mockResolvedValue([])
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    app.unmount()
    host.remove()
    document.body.innerHTML = ''
  })

  async function mount(): Promise<void> {
    app = createApp(WorkspaceOverviewPanel as never)
    app.use(ElementPlus)
    app.mount(host)
    await flushMacro()
  }

  function rows(): HTMLElement[] {
    return [...host.querySelectorAll('.el-table__row')] as HTMLElement[]
  }

  function rowContaining(text: string): HTMLElement {
    const row = rows().find(r => r.textContent?.includes(text))
    if (row == null) throw new Error(`未找到包含 ${text} 的行`)
    return row
  }

  function deleteButton(row: HTMLElement): HTMLButtonElement {
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent?.trim() === '删除')
    if (btn == null) throw new Error('行内没有删除按钮')
    return btn as HTMLButtonElement
  }

  it('通道条目用与左栏同源的合成名称与「机器人通道」类别，temp 仍被过滤', async () => {
    api.fetchOverview.mockResolvedValue({
      entries: [feishuGroup(), feishuPrivate(), dingtalkGroup(), entry('42', { kind: 'temp' })],
      error: null,
    })
    await mount()
    const text = host.textContent ?? ''
    // 名称合成：飞书群{botId}·{chatId} / 飞书私聊 / 钉钉群{botId}·{conversationId 前 10 位}
    expect(text).toContain('飞书群cli_a1b2c3·OC_67F0F76')
    expect(text).toContain('飞书私聊')
    expect(text).toContain('钉钉群bot-9·cid_group9')
    expect(text).toContain('机器人通道')
    // 会话 id 临时工作区照旧不展示
    expect(text).not.toContain('>42<')
  })

  it('群工作区删除按钮禁用（多人共享），私聊与个人目录可删', async () => {
    api.fetchOverview.mockResolvedValue({
      entries: [feishuGroup(), feishuPrivate(), entry('my-dir')],
      error: null,
    })
    await mount()
    expect(deleteButton(rowContaining('飞书群cli_a1b2c3')).disabled).toBe(true)
    expect(deleteButton(rowContaining('飞书群cli_a1b2c3')).className).toContain('is-disabled')
    expect(deleteButton(rowContaining('飞书私聊')).disabled).toBe(false)
    expect(deleteButton(rowContaining('my-dir')).disabled).toBe(false)
  })

  it('群条目的「文件管理 / 新任务」照常可用（emit 消费方不变）', async () => {
    api.fetchOverview.mockResolvedValue({ entries: [feishuGroup()], error: null })
    await mount()
    const row = rowContaining('飞书群cli_a1b2c3')
    const buttons = [...row.querySelectorAll('button')].map(b => b.textContent?.trim())
    expect(buttons).toEqual(['文件管理', '新任务', '删除'])
  })
})
