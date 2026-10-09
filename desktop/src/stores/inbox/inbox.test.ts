import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { InboxItem, InboxListResult, InboxPreference } from '@mao/contracts'

const mockFetchList = vi.fn()
const mockFetchUnreadCount = vi.fn()
const mockMarkRead = vi.fn()
const mockMarkAllRead = vi.fn()
const mockRemove = vi.fn()
const mockGetPreference = vi.fn()
const mockSavePreference = vi.fn()

vi.mock('../../api', () => ({
  fetchInboxList: mockFetchList,
  fetchInboxUnreadCount: mockFetchUnreadCount,
  markInboxItemRead: mockMarkRead,
  markInboxAllRead: mockMarkAllRead,
  removeInboxItem: mockRemove,
  getInboxPreference: mockGetPreference,
  saveInboxPreference: mockSavePreference,
}))

const { useInboxStore } = await import('./index')

function makeItem(id: number, overrides: Record<string, any> = {}): InboxItem {
  return {
    id,
    kind: 'TASK_COMPLETED',
    title: `任务 ${id}`,
    content: null,
    isRead: false,
    readAt: null,
    sessionId: 7,
    payload: null,
    createdAt: '2026-10-04T10:00:00',
    ...overrides,
  }
}

function makeList(records: InboxItem[], total = records.length): InboxListResult {
  return { records, total, page: 1, size: 20 }
}

describe('inbox store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 0 })
    mockFetchList.mockResolvedValue(makeList([]))
    mockGetPreference.mockResolvedValue({
      taskCompletedEnabled: true,
      questionPendingEnabled: true,
      approvalPendingEnabled: true,
      subagentDoneEnabled: false,
      budgetWarnEnabled: true,
      systemNotifyEnabled: true,
    } satisfies InboxPreference)
  })

  it('unreadCount 采用服务端权威值：不累加、溢出值与负数归零', () => {
    const store = useInboxStore()
    store.setUnreadCount(0)
    store.setUnreadCount(5)
    store.setUnreadCount(13)
    expect(store.unreadCount).toBe(13)

    store.setUnreadCount(Number.NaN)
    expect(store.unreadCount).toBe(0)

    store.setUnreadCount(3)
    store.setUnreadCount(-2)
    expect(store.unreadCount).toBe(0)
  })

  it('权威未读数归零时本地条目同步置已读，避免仍显示未读标识', () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1), makeItem(2)]), 1)
    expect(store.items.every((item) => !item.isRead)).toBe(true)

    store.setUnreadCount(0)
    expect(store.items.every((item) => item.isRead)).toBe(true)
  })

  it('fetchList 拉第一页并同步权威未读数', async () => {
    const store = useInboxStore()
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)], 42))
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 2 })

    await store.fetchList()

    expect(mockFetchList).toHaveBeenCalledWith({ page: 1, size: 20, unreadOnly: false })
    expect(store.items.map((i) => i.id)).toEqual([1, 2])
    expect(store.total).toBe(42)
    expect(store.hasMore).toBe(true)
    expect(store.unreadCount).toBe(2)
    expect(store.loadingList).toBe(false)
  })

  it('loadMore 追加下一页；无更多数据时不重复请求', async () => {
    const store = useInboxStore()
    mockFetchList.mockResolvedValue(makeList([makeItem(1), makeItem(2)], 42))
    await store.fetchList()
    mockFetchList.mockResolvedValue(
      makeList([makeItem(3)], 42),
    )
    // fix page/size 合并：手动构造第二页
    mockFetchList.mockResolvedValue({ records: [makeItem(3)], total: 42, page: 2, size: 20 })

    await store.loadMore()
    expect(mockFetchList).toHaveBeenLastCalledWith({ page: 2, size: 20, unreadOnly: false })
    expect(store.page).toBe(2)
    expect(store.items.map((i) => i.id)).toEqual([1, 2, 3])

    store.hasMore = false
    await store.loadMore()
    expect(mockFetchList).toHaveBeenCalledTimes(2)
  })

  it('setUnreadOnly 切换后重拉第一页并重置分页', async () => {
    const store = useInboxStore()
    mockFetchList.mockResolvedValue(makeList([makeItem(1)]))
    await store.fetchUnreadCount()

    await store.setUnreadOnly(true)
    expect(store.unreadOnly).toBe(true)
    expect(mockFetchList).toHaveBeenLastCalledWith({ page: 1, size: 20, unreadOnly: true })
    expect(store.page).toBe(1)
  })

  it('markRead 成功后本地条目已读，未读数重拉权威值（不做本地递减）', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1), makeItem(2)]), 1)
    mockMarkRead.mockResolvedValue(undefined)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 })
    store.unreadCount = 2

    await store.markRead(1)

    expect(mockMarkRead).toHaveBeenCalledWith(1)
    expect(store.items[0].isRead).toBe(true)
    expect(store.items[0].readAt).toBeTruthy()
    // 服务端权威值为 1；本地不得再 -1（否则 2→0，徽标提前消失）
    expect(mockFetchUnreadCount).toHaveBeenCalled()
    expect(store.unreadCount).toBe(1)
  })

  // 回归：服务端 markRead 后会广播权威 COUNT（WS inbox_updated）。该帧与 HTTP 响应
  // 到达顺序不确定，本地若再递减一次，同一条变更被计两遍 → 徽标从 2 直接归零。
  it('markRead：权威帧先于 HTTP 响应到达时也不把未读数减到 0', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1), makeItem(2)]), 1)
    store.unreadCount = 2
    mockMarkRead.mockResolvedValue(undefined)
    // WS 帧已把徽标刷成权威值 1（此时 HTTP 响应尚未回来）
    store.setUnreadCount(1)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 })

    await store.markRead(1)

    expect(store.unreadCount).toBe(1)
  })

  it('markRead：条目不在当前页时未读数同样刷新为权威值', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1)]), 1)
    store.unreadCount = 3
    mockMarkRead.mockResolvedValue(undefined)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 2 })

    await store.markRead(99)

    expect(store.unreadCount).toBe(2)
  })

  it('markRead 失败时保持未读态', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1)]), 1)
    store.unreadCount = 1
    mockMarkRead.mockRejectedValue(new Error('network'))

    await expect(store.markRead(1)).resolves.toBe(false)
    expect(store.items[0].isRead).toBe(false)
    expect(store.unreadCount).toBe(1)
  })

  it('markAllRead 成功时全部条目已读且未读数归零；失败时不动本地', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1), makeItem(2)]), 1)
    store.unreadCount = 2

    mockMarkAllRead.mockResolvedValue(undefined)
    await store.markAllRead()
    expect(store.items.every((i) => i.isRead)).toBe(true)
    expect(store.unreadCount).toBe(0)

    const store2 = useInboxStore()
    store2.applyPage(makeList([makeItem(3)]), 1)
    store2.unreadCount = 1
    mockMarkAllRead.mockRejectedValue(new Error('boom'))
    await store2.markAllRead()
    expect(store2.items[0].isRead).toBe(false)
    expect(store2.unreadCount).toBe(1)
  })

  it('remove 成功后本地移除条目并重拉权威未读数；失败时保留', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1), makeItem(2)], 2), 1)
    store.unreadCount = 2

    mockRemove.mockRejectedValue(new Error('boom'))
    await store.remove(1)
    expect(store.items.map((i) => i.id)).toEqual([1, 2])
    expect(store.unreadCount).toBe(2)

    mockRemove.mockResolvedValue(undefined)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 })
    await store.remove(1)
    expect(store.items.map((i) => i.id)).toEqual([2])
    expect(store.unreadCount).toBe(1)
  })

  // 回归：条目被移出本地列表后已无从判断它原本是否未读，只能以服务端 COUNT 为准
  it('remove：已读条目删除后未读数仍由服务端权威值决定（不误减）', async () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1, { isRead: true }), makeItem(2)]), 1)
    store.unreadCount = 1
    mockRemove.mockResolvedValue(undefined)
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 1 })

    await store.remove(1)

    expect(store.items.map((i) => i.id)).toEqual([2])
    expect(store.unreadCount).toBe(1)
  })

  it('visibleItems 过滤未知 kind，后端白名单之外的条目不渲染', () => {
    const store = useInboxStore()
    store.applyPage(
      makeList([
        makeItem(1),
        makeItem(2, { kind: 'MYSTERY_KIND' as any }),
        makeItem(3, { kind: 'QUESTION_PENDING' as any }),
      ]),
      1,
    )
    expect(store.visibleItems.map((i) => i.id)).toEqual([1, 3])
  })

  // 回归：KNOWN_INBOX_KINDS 曾漏掉 BUDGET_WARN，预算越限提醒在收件箱里被静默过滤；
  // 契约新增 kind 时这里会同步失败，提醒补齐白名单。
  it('kind 白名单覆盖契约全部枚举（含 BUDGET_WARN / TRIGGER_DISABLED）', () => {
    const store = useInboxStore()
    store.applyPage(
      makeList([
        makeItem(1, { kind: 'BUDGET_WARN' as any }),
        makeItem(2, { kind: 'TRIGGER_DISABLED' as any }),
        makeItem(3, { kind: 'SCHEDULED_TASK_PAUSED' as any }),
        makeItem(4, { kind: 'NOT_A_KIND' as any }),
      ]),
      1,
    )
    expect(store.visibleItems.map((i) => i.id)).toEqual([1, 2, 3])
  })

  it('偏好读写：保存后以服务端返回值为准', async () => {
    const store = useInboxStore()
    mockSavePreference.mockResolvedValue({
      taskCompletedEnabled: false,
      questionPendingEnabled: true,
      approvalPendingEnabled: true,
      subagentDoneEnabled: true,
      budgetWarnEnabled: true,
      systemNotifyEnabled: true,
    } satisfies InboxPreference)

    const ok = await store.saveInboxPreference({ taskCompletedEnabled: false })
    expect(ok).toBe(true)
    expect(store.preference.taskCompletedEnabled).toBe(false)

    mockSavePreference.mockRejectedValue(new Error('boom'))
    await expect(store.saveInboxPreference({ subagentDoneEnabled: true })).resolves.toBe(false)
    // 保存失败沿用上次成功值，不写入半截状态
    expect(store.preference.subagentDoneEnabled).toBe(true)
  })

  it('偏好读取失败时保留当前值', async () => {
    const store = useInboxStore()
    mockGetPreference.mockRejectedValue(new Error('boom'))
    const pref = await store.fetchInboxPreference()
    expect(pref.taskCompletedEnabled).toBe(true)
    expect(pref.subagentDoneEnabled).toBe(false)
  })
})
