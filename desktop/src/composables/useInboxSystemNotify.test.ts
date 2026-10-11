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

// 单测跑在 node 环境：Notification / document / router 均需替身。
const created: Array<{ title: string; body: string; tag?: string; onclick?: () => void }> = []
let permissionState: NotificationPermission = 'granted'
const requestPermission = vi.fn(async () => permissionState)
let hasFocus = true
let hidden = false

class FakeNotification {
  constructor(title: string, options?: { body?: string; tag?: string }) {
    created.push({ title, body: options?.body ?? '', tag: options?.tag, onclick: undefined })
    this.title = title
  }
  title: string
  static get permission(): NotificationPermission {
    return permissionState
  }
  static requestPermission = requestPermission
  close = vi.fn()
  set onclick(fn: () => void) {
    const current = created[created.length - 1]
    if (current) current.onclick = fn
  }
}

;(globalThis as any).Notification = FakeNotification
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    get hidden() {
      return hidden
    },
    hasFocus: () => hasFocus,
  },
})
;(globalThis as any).window = { focus: vi.fn() }

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
    created.length = 0
    permissionState = 'granted'
    requestPermission.mockImplementation(async () => permissionState)
    hasFocus = true
    hidden = false
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
    expect(isInboxKindEnabled('WEIXIN_REPLY_WINDOW_CLOSED', allOn)).toBe(true)
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
    expect(created).toHaveLength(0)
  })

  it('未建立基线时只播种不弹历史通知', async () => {
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false

    await notifyInboxSystemUpdate()

    expect(created).toHaveLength(0)
    // 基线已播种，随后的新增条目可正常弹
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))
    await notifyInboxSystemUpdate()
    expect(created.map((c) => c.title)).toEqual(['任务 3'])
  })

  it('失焦且新增条目时逐条弹系统通知，带标题/摘要', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))

    await notifyInboxSystemUpdate()

    expect(created.map((c) => c.title)).toEqual(['任务 2', '任务 3'])
    expect(created[0].body).toBe('摘要')
    expect(created[0].tag).toBe('mao-inbox-2')
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
    expect(created.map((c) => c.title)).toEqual(['任务 3'])
  })

  it('requestPermission 返回 denied 时静默降级：不弹、不抛、不拉列表', async () => {
    permissionState = 'denied'
    await notifyInboxSystemUpdate()
    expect(mockFetchList).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)

    // 已播种基线后同样不弹不报
    await seedList([makeItem(1)])
    hasFocus = false
    await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('requestPermission 需要用户手势时（prompt）确认 granted 后弹窗', async () => {
    permissionState = 'default'
    requestPermission.mockResolvedValue('granted')
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)]))

    await notifyInboxSystemUpdate()

    expect(requestPermission).toHaveBeenCalled()
    expect(created.map((c) => c.title)).toEqual(['任务 2'])
  })

  it('系统通知总开关关闭时不弹：与 kind 级开关相互独立', async () => {
    const preference = { ...allOn, systemNotifyEnabled: false }
    await seedList([makeItem(1)], preference)
    hasFocus = false
    mockFetchList.mockResolvedValue(
      makeList([makeItem(1), makeItem(2), makeItem(3, { kind: 'QUESTION_PENDING' })]),
    )

    await notifyInboxSystemUpdate()

    expect(created).toHaveLength(0)
  })

  it('requestPermission 抛异常时静默降级', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    requestPermission.mockRejectedValue(new Error('denied by gesture'))
    await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('点击通知聚焦窗口并跳转关联会话', async () => {
    await seedList([makeItem(1)])
    hasFocus = false
    mockFetchList.mockResolvedValue(
      makeList([makeItem(1), makeItem(2, { sessionId: 77 })]),
    )
    mockFetchSession.mockResolvedValue({ id: '77' })

    await notifyInboxSystemUpdate()
    expect(created).toHaveLength(1)
    created[0].onclick?.()

    await vi.waitFor(() => {
      expect(mockSetActiveSession).toHaveBeenCalledWith('77')
    })
    await vi.waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/tasks/77')
    })
    expect((globalThis as any).window.focus).toHaveBeenCalled()
  })

  it('primeInboxSystemNotify 显式重置基线：清空后即使窗口失焦也不再弹', async () => {
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false
    await notifyInboxSystemUpdate()
    expect(created).toHaveLength(0)
  })

  it('跨页新增不会被重复弹：同一条 id 只通知一次', async () => {
    // 基线只覆盖第一页；条目滑出第一页后仍应记住已弹过，不得再次弹窗
    await seedList([makeItem(1), makeItem(2)])
    hasFocus = false
    mockFetchList.mockResolvedValue(makeList([makeItem(3), makeItem(4)]))
    await notifyInboxSystemUpdate()
    expect(created.map((c) => c.title)).toEqual(['任务 3', '任务 4'])

    // 下一条推送里 3/4 已滑出第一页（只剩 5 与更早已读内容）：不得二次弹 3/4
    mockFetchList.mockResolvedValue(makeList([makeItem(5, { isRead: true }), makeItem(3), makeItem(4)]))
    await notifyInboxSystemUpdate()
    expect(created.map((c) => c.title)).toEqual(['任务 3', '任务 4', '任务 5'])
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

      expect(created.map((c) => c.title)).toEqual(['任务 3', '任务 4'])
    })

    it('从未打开过抽屉时，首帧 inbox_updated 只播种不弹历史通知，第二次才弹新增', async () => {
      // 无 drawer watcher：基线由通知逻辑自己建立（peek 不触发任何 watcher）
      await seedListWithoutDrawer([makeItem(1), makeItem(2)])
      hasFocus = false

      await notifyInboxSystemUpdate()
      expect(created).toHaveLength(0)

      mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2), makeItem(3)]))
      await notifyInboxSystemUpdate()
      expect(created.map((c) => c.title)).toEqual(['任务 3'])
    })

    it('peek 拉取失败时静默结束：不清空基线、不弹通知、不抛错', async () => {
      await seedList([makeItem(1)])
      hasFocus = false
      mockFetchList.mockRejectedValue(new Error('network'))

      await expect(notifyInboxSystemUpdate()).resolves.toBeUndefined()
      expect(created).toHaveLength(0)

      // 网络恢复后基线仍在（{1}），新增条目仍可正常弹
      mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)]))
      await notifyInboxSystemUpdate()
      expect(created.map((c) => c.title)).toEqual(['任务 2'])
    })

    it('peek 返回空列表时也播种基线：不把「空 inbox」当成上次已知集合清空失败', async () => {
      await seedList([makeItem(1), makeItem(2)])
      hasFocus = false
      // 用户把两条都删了 → 列表为空；这轮播种空基线，不弹任何通知
      mockFetchList.mockResolvedValue(makeList([]))
      await notifyInboxSystemUpdate()
      expect(created).toHaveLength(0)

      // 新条目到来了：相对空基线是新增，正常弹
      mockFetchList.mockResolvedValue(makeList([makeItem(3)]))
      await notifyInboxSystemUpdate()
      expect(created.map((c) => c.title)).toEqual(['任务 3'])
    })
  })
})
