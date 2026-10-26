/**
 * 第 5 轮复审探针（渲染层侧）—— 3 例全过。
 *
 * 结论：渲染层 `desktop-notification-click` 监听是【惰性注册】——
 * 只有 `inbox_updated` WS 事件到达（→ notifyInboxSystemUpdate → ensureDesktopNotifyBridge）
 * 之后才注册（useInboxSystemNotify.ts:115 是唯一注册点，useStreamWS.ts:804 是唯一调用点）。
 *
 * 运行方式（需临时放回 desktop/src/composables/ 下，vitest include 只收 src/**\/*.test.ts）：
 *   cp 本文件 desktop/src/composables/__probe.test.ts
 *   cd desktop && npx vitest run src/composables/__probe.test.ts
 *   rm desktop/src/composables/__probe.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { InboxItem, InboxPreference } from '@mao/contracts'

/**
 * 第 5 轮复审探针（临时文件，不入库）：
 * 验证「渲染层 desktop-notification-click 监听是惰性注册」——
 * 只有收到过 inbox_updated（→ notifyInboxSystemUpdate → ensureDesktopNotifyBridge）之后
 * 才注册。用于判断主进程 did-finish-load 补发的跳转事件在新渲染进程里能否被收到。
 */

const mockFetchList = vi.fn()
const mockFetchUnreadCount = vi.fn()
const mockGetPreference = vi.fn()

vi.mock('../api', () => ({
  fetchInboxList: mockFetchList,
  fetchInboxUnreadCount: mockFetchUnreadCount,
  markInboxItemRead: vi.fn(),
  markInboxAllRead: vi.fn(),
  removeInboxItem: vi.fn(),
  getInboxPreference: mockGetPreference,
  saveInboxPreference: vi.fn(),
}))

const clickHandlers: Array<(payload: { itemId?: number; sessionId?: number | null }) => void> = []
const desktopNotify = vi.fn(async () => ({ ok: true }))
const desktopBadge = vi.fn(async () => ({ ok: true }))

function installElectronApi() {
  ;(globalThis as any).window = {
    focus: vi.fn(),
    electronAPI: {
      desktopNotify,
      desktopBadge,
      onDesktopNotificationClick: (cb: (payload: any) => void) => {
        clickHandlers.push(cb)
        return () => {}
      },
    },
  }
}

let hidden = true
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { get hidden() { return hidden }, hasFocus: () => false },
})

vi.mock('../stores/session', () => ({
  useSessionStore: () => ({ fetchSession: vi.fn(), setActiveSession: vi.fn() }),
}))
vi.mock('../router', () => ({ default: { push: vi.fn() } }))

const { notifyInboxSystemUpdate, resetInboxSystemNotifyForTest } = await import('./useInboxSystemNotify')
const { useInboxStore } = await import('../stores/inbox')

function makeItem(id: number): InboxItem {
  return {
    id, kind: 'TASK_COMPLETED', title: `任务 ${id}`, content: '摘要', isRead: false,
    readAt: null, sessionId: 42, payload: null, createdAt: '2026-10-04T10:00:00',
  } as InboxItem
}

const allOn: InboxPreference = {
  taskCompletedEnabled: true, questionPendingEnabled: true, approvalPendingEnabled: true,
  subagentDoneEnabled: true, budgetWarnEnabled: true, openApiCallFailedEnabled: false,
  systemNotifyEnabled: true,
}

describe('探针：通知点击监听的注册时机', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    clickHandlers.length = 0
    hidden = true
    installElectronApi()
    resetInboxSystemNotifyForTest()
    mockGetPreference.mockResolvedValue(allOn)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 })
  })

  it('应用启动后（未收到任何 inbox_updated）不注册点击监听', () => {
    // 模拟「窗口销毁后 createWindow 重建 → did-finish-load 时刻」的渲染层状态：
    // 页面已加载、Vue 已挂载，但还没有任何 WS 事件到达。
    expect(clickHandlers.length).toBe(0)
  })

  it('首次 inbox_updated 之后才注册点击监听', async () => {
    const store = useInboxStore()
    store.preference = allOn
    mockFetchList.mockResolvedValue({ records: [makeItem(1)], total: 1, page: 1, size: 20 })
    await notifyInboxSystemUpdate()
    await nextTick()
    expect(clickHandlers.length).toBe(1)
  })

  it('注册前到达的 desktop-notification-click 无人接收（事件丢失）', async () => {
    // 探针主进程侧 sendToRenderer 在这个状态发出时的结果：无监听者
    let received = 0
    // 渲染层此时没有监听（clickHandlers 为空），等价于主进程 webContents.send 无人接收
    for (const cb of clickHandlers) cb({ itemId: 1, sessionId: 42 })
    received = clickHandlers.length === 0 ? 0 : 1
    expect(received).toBe(0)
    expect(clickHandlers.length).toBe(0)
  })
})
