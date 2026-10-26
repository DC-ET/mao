import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, watch } from 'vue'
import type { InboxItem, InboxPreference } from '@mao/contracts'

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

// 单测跑在 node 环境：document / router 均需替身；投递通道替身为 window.electronAPI.desktopNotify。
interface NotifyCall {
  title: string
  body: string
  tag?: string
  itemId?: number | null
  sessionId?: number | null
}
const notifyCalls: NotifyCall[] = []
const badgeCalls: number[] = []
const clickHandlers: Array<(payload: { itemId?: number; sessionId?: number | null }) => void> = []
let hasFocus = true
let hidden = false

const desktopNotify = vi.fn(async (payload: NotifyCall) => {
  notifyCalls.push(payload)
  return { ok: true }
})
const desktopBadge = vi.fn(async (count: number) => {
  badgeCalls.push(count)
  return { ok: true }
})

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

function removeElectronApi() {
  ;(globalThis as any).window = { focus: vi.fn() }
}

installElectronApi()

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    get hidden() {
      return hidden
    },
    hasFocus: () => hasFocus,
  },
})

const mockFetchSession = vi.fn()
const mockSetActiveSession = vi.fn()
const mockRouterPush = vi.fn()

vi.mock('../stores/session', () => ({
  useSessionStore: () => ({
    fetchSession: mockFetchSession,
    setActiveSession: mockSetActiveSession,
  }),
}))
vi.mock('../router', () => ({
  default: { push: mockRouterPush },
}))

const {
  isInboxKindEnabled,
  isInboxNotifyWindowHidden,
  primeInboxSystemNotify,
  notifyInboxSystemUpdate,
  resetInboxSystemNotifyForTest,
} = await import('./useInboxSystemNotify')
const { useInboxStore } = await import('../stores/inbox')

function makeItem(id: number, overrides: Record<string, any> = {}): InboxItem {
  return {
    id,
    kind: 'TASK_COMPLETED',
    title: `任务 ${id}`,
    content: '摘要',
    isRead: false,
    readAt: null,
    sessionId: 42,
    payload: null,
    createdAt: '2026-10-04T10:00:00',
    ...overrides,
  }
}

const allOn: InboxPreference = {
  taskCompletedEnabled: true,
  questionPendingEnabled: true,
  approvalPendingEnabled: true,
  subagentDoneEnabled: true,
  budgetWarnEnabled: true,
  openApiCallFailedEnabled: false,
  systemNotifyEnabled: true,
}

function makeList(records: InboxItem[]) {
  return { records, total: records.length, page: 1, size: 20 }
}

/**
 * 复刻 InboxDrawer 的 items watcher（组件与顶层布局同生命周期，无需打开抽屉即生效），
 * 用于复现 BUG-6 的集成时序：`fetchList()` 整体替换 `store.items` → watcher 同步 flush
 * 播种基线。播种器与 diff 数据源一旦共享这条写路径，diff 就恒为空。
 */
let drawerWatcherStop: (() => void) | null = null

function mountDrawerWatcher(store: ReturnType<typeof useInboxStore>) {
  drawerWatcherStop?.()
  drawerWatcherStop = watch(
    () => store.items,
    (items) => primeInboxSystemNotify(items),
    { deep: true }
  )
}

/** 打开抽屉的真实链路：fetchList 替换 items → 常驻 watcher 在 flush 时播种基线。 */
async function seedList(records: InboxItem[], preference = allOn) {
  const store = useInboxStore()
  mountDrawerWatcher(store)
  store.preference = preference
  mockFetchList.mockResolvedValue(makeList(records))
  mockFetchUnreadCount.mockResolvedValue({ unreadCount: records.length })
  await store.fetchList()
  await nextTick()
  return store
}

/** 无抽屉 watcher 的链路（从未打开过抽屉时的首帧）：基线由通知逻辑自己建立。 */
async function seedListWithoutDrawer(records: InboxItem[], preference = allOn) {
  const store = useInboxStore()
  store.preference = preference
  mockFetchList.mockResolvedValue(makeList(records))
  mockFetchUnreadCount.mockResolvedValue({ unreadCount: records.length })
  await store.fetchList()
  await nextTick()
  return store
}

describe('useInboxSystemNotify', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    notifyCalls.length = 0
    badgeCalls.length = 0
    clickHandlers.length = 0
    hasFocus = true
    hidden = false
    installElectronApi()
    resetInboxSystemNotifyForTest()
    drawerWatcherStop?.()
    drawerWatcherStop = null
    mockGetPreference.mockResolvedValue(allOn)
  })

  afterEach(() => {
    resetInboxSystemNotifyForTest()
    drawerWatcherStop?.()
    drawerWatcherStop = null
  })

  it('kind 过滤：只为开启的 kind 放行', () => {
    expect(isInboxKindEnabled('TASK_COMPLETED', allOn)).toBe(true)
    expect(isInboxKindEnabled('TASK_FAILED', allOn)).toBe(true)
    expect(isInboxKindEnabled('QUESTION_PENDING', allOn)).toBe(true)
    expect(isInboxKindEnabled('APPROVAL_PENDING', allOn)).toBe(true)
    expect(isInboxKindEnabled('SUBAGENT_DONE', { ...allOn, subagentDoneEnabled: false })).toBe(false)
    expect(isInboxKindEnabled('SUBAGENT_DONE', allOn)).toBe(true)
    // 未知 kind 一律不弹
    expect(isInboxKindEnabled('MYSTERY' as any, allOn)).toBe(false)
  })

  it('窗口状态口径锁定为 document.hidden || !document.hasFocus()', () => {
    expect(isInboxNotifyWindowHidden()).toBe(false)
    hidden = true
    expect(isInboxNotifyWindowHidden()).toBe(true)
    hidden = false
    hasFocus = false
    expect(isInboxNotifyWindowHidden()).toBe(true)
  })

  it('窗口聚焦时不弹通知，也不拉列表', async () => {
    await notifyInboxSystemUpdate()
    expect(mockFetchList).not.toHaveBeenCalled()
    expect(notifyCalls).toHaveLength(0)
  })

  it('非 Electron（无 electronAPI.desktopNotify）整体不弹：不拉列表、不报错', async () => {
    removeElectronApi()
    await seedList([makeItem(1)])
    // seedList 自身的 fetchList 调用不计入：清掉调用记录后验证 notify 路径完全不触达
    vi.clearAllMocks()
    hasFocus = false
    await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
    expect(mockFetchList).not.toHaveBeenCalled()
    expect(notifyCalls).toHaveLength(0)
  })

  it('未建立基线时只播种不弹历史通知', async () => {
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false

    await notifyInboxSystemUpdate()

    expect(notifyCalls).toHaveLength(0)
    // 基线已播种，随后的新增条目可正常弹
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))
    await notifyInboxSystemUpdate()
    expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3'])
  })

  it('失焦且新增条目时逐条走主进程投递，带标题/摘要/tag/会话', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))

    await notifyInboxSystemUpdate()

    expect(notifyCalls.map((c) => c.title)).toEqual(['任务 2', '任务 3'])
    expect(notifyCalls[0].body).toBe('摘要')
    expect(notifyCalls[0].tag).toBe('mao-inbox-2')
    expect(notifyCalls[0].itemId).toBe(2)
    expect(notifyCalls[0].sessionId).toBe(42)
  })

  it('偏好关闭的 kind 不弹：默认关闭的 SUBAGENT_DONE 也不弹', async () => {
    const preference = { ...allOn, taskCompletedEnabled: false, subagentDoneEnabled: false }
    await seedList([makeItem(1)], preference)
    hasFocus = false
    mockFetchList.mockResolvedValue(
      makeList([
        makeItem(1),
        makeItem(2, { kind: 'SUBAGENT_DONE' }),
        makeItem(3, { kind: 'QUESTION_PENDING' }),
      ]),
    )

    await notifyInboxSystemUpdate()

    // 关闭的 TASK_COMPLETED / SUBAGENT_DONE 都不弹；开启的 QUESTION_PENDING 弹
    expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3'])
  })

  it('系统通知总开关关闭时不弹：与 kind 级开关相互独立', async () => {
    const preference = { ...allOn, systemNotifyEnabled: false }
    await seedList([makeItem(1)], preference)
    hasFocus = false
    mockFetchList.mockResolvedValue(
      makeList([makeItem(1), makeItem(2), makeItem(3, { kind: 'QUESTION_PENDING' })]),
    )

    await notifyInboxSystemUpdate()

    expect(notifyCalls).toHaveLength(0)
  })

  it('主进程投递失败（invoke 抛错）时静默降级：不影响站内徽标、不抛出', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)]))
    desktopNotify.mockRejectedValueOnce(new Error('display failed'))

    await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
    expect(notifyCalls).toHaveLength(0)
  })

  it('通知点击回传：主进程事件触发后跳转关联会话', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(
      makeList([makeItem(1), makeItem(2, { sessionId: 77 })]),
    )
    mockFetchSession.mockResolvedValue({ id: '77' })

    await notifyInboxSystemUpdate()
    expect(notifyCalls).toHaveLength(1)
    // 桥接在首次投递时注册点击监听；触发回传事件
    expect(clickHandlers.length).toBeGreaterThan(0)
    clickHandlers[clickHandlers.length - 1]({ itemId: 2, sessionId: 77 })

    await vi.waitFor(() => {
      expect(mockSetActiveSession).toHaveBeenCalledWith('77')
    })
    await vi.waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/tasks/77')
    })
  })

  it('通知点击回传缺 sessionId 时不跳转', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)]))

    await notifyInboxSystemUpdate()
    clickHandlers[clickHandlers.length - 1]({ itemId: 2, sessionId: null })

    expect(mockSetActiveSession).not.toHaveBeenCalled()
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it('dock 角标跟随收件箱未读数（含立即同步一次）', async () => {
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false
    // 首次投递时注册角标观察（immediate）：当前未读 2 立即同步
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))
    await notifyInboxSystemUpdate()
    expect(badgeCalls[badgeCalls.length - 1]).toBe(2)

    // 未读数变化 → 角标跟随
    const store = useInboxStore()
    store.setUnreadCount(5)
    await nextTick()
    expect(badgeCalls[badgeCalls.length - 1]).toBe(5)

    // 登出清零语义：0 也透传（主进程清角标）
    store.setUnreadCount(0)
    await nextTick()
    expect(badgeCalls[badgeCalls.length - 1]).toBe(0)
  })

  it('primeInboxSystemNotify 显式重置基线：清空后即使窗口失焦也不再弹', async () => {
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false
    await notifyInboxSystemUpdate()
    expect(notifyCalls).toHaveLength(0)
  })

  it('跨页新增不会被重复弹：同一条 id 只通知一次', async () => {
    // 基线只覆盖第一页；条目滑出第一页后仍应记住已弹过，不得再次弹窗
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(3), makeItem(4)]))
    await notifyInboxSystemUpdate()
    expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3', '任务 4'])

    // 下一条推送里 3/4 已滑出第一页（只剩 5 与更早已读内容）：不得二次弹 3/4
    mockFetchList.mockResolvedValue(makeList([makeItem(5, { isRead: true }), makeItem(3), makeItem(4)]))
    await notifyInboxSystemUpdate()
    expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3', '任务 4', '任务 5'])
  })

  // ─── BUG-6 回归：diff 数据源与「打开抽屉播种」必须解耦 ───
  describe('BUG-6 回归：抽屉 watcher 常驻时系统通知仍须触发', () => {
    afterEach(() => {
      drawerWatcherStop?.()
      drawerWatcherStop = null
    })

    it('挂上 InboxDrawer items watcher 后，新增条目仍能弹出系统通知', async () => {
      // 真实链路：用户打开过一次抽屉（watcher 常驻且已播种 {1,2}），随后收到推送。
      // 若 diff 走 fetchList（写 items）→ watcher 抢先播种 → diff 恒为空 → 一条都不弹。
      await seedList([makeItem(1), makeItem(2)])
      hasFocus = false
      mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3), makeItem(4)]))

      await notifyInboxSystemUpdate()

      expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3', '任务 4'])
    })

    it('从未打开过抽屉时，首帧 inbox_updated 只播种不弹历史通知，第二次才弹新增', async () => {
      // 无 drawer watcher：基线由通知逻辑自己建立（peek 不触发任何 watcher）
      await seedListWithoutDrawer([makeItem(1), makeItem(2)])
      hasFocus = false

      await notifyInboxSystemUpdate()
      expect(notifyCalls).toHaveLength(0)

      mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))
      await notifyInboxSystemUpdate()
      expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3'])
    })

    it('peek 拉取失败时静默结束：不清空基线、不弹通知、不抛错', async () => {
      await seedList([makeItem(1)])
      hasFocus = false
      mockFetchList.mockRejectedValue(new Error('network'))

      await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
      expect(notifyCalls).toHaveLength(0)

      // 网络恢复后基线仍在（{1}），新增条目仍可正常弹
      mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)]))
      await notifyInboxSystemUpdate()
      expect(notifyCalls.map((c) => c.title)).toEqual(['任务 2'])
    })

    it('peek 返回空列表时也播种基线：不把「空 inbox」当成上次已知集合清空失败', async () => {
      await seedList([makeItem(1), makeItem(2)])
      hasFocus = false
      // 用户把两条都删了 → 列表为空；这轮播种空基线，不弹任何通知
      mockFetchList.mockResolvedValue(makeList([]))
      await notifyInboxSystemUpdate()
      expect(notifyCalls).toHaveLength(0)

      // 新条目到来了：相对空基线是新增，正常弹
      mockFetchList.mockResolvedValue(makeList([makeItem(3)]))
      await notifyInboxSystemUpdate()
      expect(notifyCalls.map((c) => c.title)).toEqual(['任务 3'])
    })
  })
})
