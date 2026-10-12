import { describe, expect, it, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useInboxStore, isKnownInboxKind } from './index'
import type { InboxItem, InboxKind, InboxListResult } from '@mao/contracts'

/**
 * 回归（BUG-2）：桌面 `KNOWN_INBOX_KINDS` 白名单漏 `WEIXIN_REPLY_WINDOW_CLOSED`。
 * 该 kind 由 commit 731fa2b6（0.0.258）加入后端 INBOX_KINDS，未同步桌面，
 * 导致落库条目不渲染（铃铛未读数比列表多 1），且不可点、不可置已读。
 * 上一次同类漂移（BUDGET_WARN 漏白名单）已有回归测试。
 *
 * 2026-10-12：原实现手抄了一份后端 `INBOX_KINDS` 副本用于比对，该副本本身
 * 又漏了 0.0.278 新增的 `WATCHER_DISABLED`——副本比对副本会一起过期。
 * 现改为把每个 kind 显式标注为契约类型 `InboxKind`：契约新增成员而这里漏写时，
 * `vitest` 的 tsc 检查直接报 TS2322，不再依赖副本同步。
 */
const ALL_INBOX_KINDS: InboxKind[] = [
  'TASK_COMPLETED',
  'TASK_FAILED',
  'QUESTION_PENDING',
  'APPROVAL_PENDING',
  'SUBAGENT_DONE',
  'TRIGGER_DISABLED',
  'BUDGET_WARN',
  'SCHEDULED_TASK_PAUSED',
  'TOKEN_DISABLED',
  'OPEN_API_CALL_FAILED',
  'WEIXIN_REPLY_WINDOW_CLOSED',
  'WATCHER_DISABLED',
]

function makeItem(id: number, kind: InboxKind): InboxItem {
  return {
    id,
    kind,
    title: `t${id}`,
    content: null,
    isRead: false,
    readAt: null,
    sessionId: null,
    payload: null,
    createdAt: '2026-10-11 10:00:00',
  }
}

function makeList(items: InboxItem[]): InboxListResult {
  return { records: items, total: items.length, page: 1, size: 20 }
}

describe('BUG-2 回归：收件箱 kind 白名单与后端契约漂移', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('C1 契约里每个 kind 都必须被桌面白名单识别', () => {
    const missing = ALL_INBOX_KINDS.filter((kind) => !isKnownInboxKind(kind))
    console.log('C1 桌面白名单缺失的 kind =', JSON.stringify(missing), '（应为 []）')
    expect(missing).toEqual([])
  })

  it('C2 WEIXIN_REPLY_WINDOW_CLOSED 条目必须在收件箱列表可见', () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1, 'WEIXIN_REPLY_WINDOW_CLOSED' as InboxKind)]), 1)
    console.log('C2 visibleItems =', JSON.stringify(store.visibleItems.map((i) => i.id)), '（应为 [1]）')
    expect(store.visibleItems.map((i) => i.id)).toEqual([1])
  })

  it('C3 未知 kind 仍应被过滤（白名单不能退化为全通）', () => {
    const store = useInboxStore()
    store.applyPage(makeList([makeItem(1, 'NOT_A_KIND' as InboxKind), makeItem(2, 'TASK_COMPLETED')]), 1)
    expect(store.visibleItems.map((i) => i.id)).toEqual([2])
  })
})
