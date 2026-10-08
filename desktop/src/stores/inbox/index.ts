import { defineStore } from 'pinia'
import type { InboxItem, InboxKind, InboxListResult, InboxPreference } from '@mao/contracts'
import {
  fetchInboxList,
  fetchInboxUnreadCount,
  markInboxItemRead,
  markInboxAllRead,
  removeInboxItem,
  getInboxPreference,
  saveInboxPreference
} from '../../api'

const PAGE_SIZE = 20

/** 收件箱 kind 封闭集合：与契约枚举、后端写入白名单一致。 */
const KNOWN_INBOX_KINDS = new Set<string>([
  'TASK_COMPLETED',
  'TASK_FAILED',
  'QUESTION_PENDING',
  'APPROVAL_PENDING',
  'SUBAGENT_DONE',
  'BUDGET_WARN',
  'TRIGGER_DISABLED'
])

/**
 * kind 白名单判定。store getter 与系统通知 diff 共用同一实现，
 * 避免两处各写一份集合而漂移（新增 kind 时只改这里）。
 */
export function isKnownInboxKind(kind: string): kind is InboxKind {
  return KNOWN_INBOX_KINDS.has(kind)
}

/**
 * 站内收件箱状态。
 *
 * 未读数是服务端 COUNT 的权威值（WS `inbox_updated` 推送 + 打开抽屉/重连时重拉），
 * 前端禁止本地累加或从 session.unread 推导——两套是独立概念（红线 #2）。
 */
export const useInboxStore = defineStore('inbox', {
  state: () => ({
    items: [] as InboxItem[],
    unreadCount: 0,
    page: 1,
    size: PAGE_SIZE,
    total: 0,
    hasMore: false,
    loadingList: false,
    loadingMore: false,
    unreadOnly: false,
    preference: {
      taskCompletedEnabled: true,
      questionPendingEnabled: true,
      approvalPendingEnabled: true,
      subagentDoneEnabled: false,
      // 与后端 DEFAULT_PREFERENCE 列默认值一致：缺字段会让系统通知偏好落到
      // undefined，前端/后端两处口径必须同时维护（契约共享字段）
      budgetWarnEnabled: true,
      systemNotifyEnabled: true
    }
  }),

  getters: {
    /** 未知 kind 一律不渲染（防御性过滤：后端已白名单，这里兜底）。 */
    visibleItems(state): InboxItem[] {
      return state.items.filter((item) => isKnownInboxKind(item.kind))
    }
  },

  actions: {
    setUnreadCount(count: number): void {
      // 服务端权威值：不接受负数（后端 COUNT 不会为负，异常值说明帧不可信）
      this.unreadCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
      // 权威数为 0 时本地条目必须同步为已读，否则列表仍显示未读标识
      if (this.unreadCount === 0) {
        for (const item of this.items) item.isRead = true
      }
    },

    async fetchUnreadCount(): Promise<void> {
      try {
        const { unreadCount } = await fetchInboxUnreadCount()
        this.setUnreadCount(unreadCount)
      } catch {
        // 错误 toast 由 API 拦截器统一处理；徽标保留上次的权威值
      }
    },

    /** 拉取第一页（打开抽屉时调用，兼作 `inbox_updated` 极端丢失的兜底）。 */
    async fetchList(): Promise<void> {
      this.loadingList = true
      try {
        const result = await fetchInboxList({ page: 1, size: this.size, unreadOnly: this.unreadOnly })
        this.applyPage(result, 1)
        await this.fetchUnreadCount()
      } catch {
        // toast 已由拦截器处理
      } finally {
        this.loadingList = false
      }
    },

    /**
     * 系统通知 diff 专用：拉取第一页用于「新增条目」diff，**不写入 `items`**，只返回数据。
     *
     * 与 `fetchList` 分离的原因：`items` 被整体替换会触发 InboxDrawer 的 items watcher
     * （常驻，无需打开抽屉即生效），把刚拉到的整页播种进通知基线 → diff 恒为空 → 系统
     * 通知永不触发。diff 的数据源必须与「打开抽屉播种」这条写路径解耦。
     *
     * 返回 `null` 表示拉取失败（与「确实一条都没有」区分）：调用方据此沿用当前基线，
     * 既不清空已知集合、也不把「空 inbox」误当成基线播种。
     */
    async peekInboxFirstPage(): Promise<InboxItem[] | null> {
      try {
        const result = await fetchInboxList({ page: 1, size: this.size, unreadOnly: this.unreadOnly })
        return result.records.filter((item) => isKnownInboxKind(item.kind))
      } catch {
        // toast 已由拦截器处理
        return null
      }
    },

    async loadMore(): Promise<void> {
      if (this.loadingMore || !this.hasMore) return
      const next = this.page + 1
      this.loadingMore = true
      try {
        const result = await fetchInboxList({ page: next, size: this.size, unreadOnly: this.unreadOnly })
        this.applyPage(result, next)
      } catch {
        // toast 已由拦截器处理
      } finally {
        this.loadingMore = false
      }
    },

    applyPage(result: InboxListResult, page: number): void {
      this.items = result.records
      this.page = page
      this.size = result.size
      this.total = result.total
      this.hasMore = page * result.size < result.total
    },

    /** 切换只看未读：重置分页并重拉第一页。 */
    async setUnreadOnly(value: boolean): Promise<void> {
      this.unreadOnly = value
      await this.fetchList()
    },

    /**
     * 单条置已读：本地只更新条目自身，未读数一律重拉权威值。
     *
     * 不能本地 `-= 1`：服务端 markRead 后已经广播过权威 COUNT（WS `inbox_updated`），
     * 若本地再减一次就会把同一条变更计两遍 —— 徽标会从 2 直接归零（2→1→0），
     * 而服务端真实未读仍是 1。本地递减也覆盖不了「条目不在当前页」的情况。
     */
    async markRead(id: number): Promise<boolean> {
      try {
        await markInboxItemRead(id)
      } catch {
        return false
      }
      const item = this.items.find((i) => i.id === id)
      if (item != null) {
        item.isRead = true
        if (item.readAt == null) item.readAt = new Date().toISOString()
      }
      await this.fetchUnreadCount()
      return true
    },

    async markAllRead(): Promise<void> {
      try {
        await markInboxAllRead()
      } catch {
        return
      }
      for (const item of this.items) {
        item.isRead = true
        if (item.readAt == null) item.readAt = new Date().toISOString()
      }
      this.setUnreadCount(0)
    },

    /**
   * 删除单条：本地同步移除条目，未读数重拉权威值。
   * 与 `markRead` 同理——服务端 remove 已广播权威 COUNT，本地再递减会重复计数；
   * 且条目被删除后已无法从本地列表判断它原本是否未读，本地递减本就不可靠。
   */
  async remove(id: number): Promise<void> {
      try {
        await removeInboxItem(id)
      } catch {
        return
      }
      const index = this.items.findIndex((i) => i.id === id)
      if (index < 0) return
      this.items.splice(index, 1)
      await this.fetchUnreadCount()
    },

    async fetchInboxPreference(): Promise<InboxPreference> {
      try {
        const data = await getInboxPreference()
        this.preference = data
      } catch {
        // toast 已由拦截器处理；保留当前值
      }
      return this.preference
    },

    async saveInboxPreference(patch: Partial<InboxPreference>): Promise<boolean> {
      const next: InboxPreference = { ...this.preference, ...patch }
      try {
        const saved = await saveInboxPreference(next)
        this.preference = saved
        return true
      } catch {
        return false
      }
    }
  }
})
