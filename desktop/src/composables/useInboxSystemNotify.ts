import { onScopeDispose, watch } from 'vue'
import type { InboxItem, InboxKind, InboxPreference } from '@mao/contracts'
import { useInboxStore } from '../stores/inbox'
import { useSessionStore } from '../stores/session'

/**
 * Electron 系统通知（P2）：窗口未聚焦 / 最小化 / 隐藏到托盘时，把新增的收件箱条目弹成系统通知。
 *
 * 约束：
 * - 仅 Electron 生效：投递走主进程 `desktop-notify` IPC（主进程 Notification 窗口销毁后仍可达），
 *   Web/安卓没有 electronAPI，整体不弹（与改造前一致，无 web Notification 回退分支）。
 * - 主进程通知不走 web permission：删除渲染层 requestPermissionOnce（系统授权由 OS 管）。
 * - 触发条件 = `document.hidden || !document.hasFocus()`（hidden 覆盖最小化/隐藏到托盘，hasFocus 覆盖可见但未聚焦）。
 * - 事件只带权威 unreadCount，通知的标题/摘要由这里拉列表后 diff 得出（不做「事件携带内容」方案）。
 * - 通知点击：主进程 `desktop-notification-click` 回传 {itemId, sessionId}，渲染层聚焦窗口并跳会话。
 */

/**
 * 模块级基线：与 useStreamWS 的单例生命周期一致，避免多组件重复弹同一条。
 * - `knownIds`：当前已知条目（打开抽屉时播种为第一页，浏览期间新条目因此不弹）。
 * - `notifiedIds`：已弹过系统通知的条目（单调累积，跨页新增不会被重复弹）。
 */
let knownIds = new Set<string>()
let primed = false
let notifiedIds = new Set<string>()
/** 点击回传监听 + dock 角标观察的幂等注册标记 */
let bridgeSetup = false

export function isInboxKindEnabled(kind: InboxKind, preference: InboxPreference): boolean {
  switch (kind) {
    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
      return preference.taskCompletedEnabled
    case 'QUESTION_PENDING':
      return preference.questionPendingEnabled
    case 'APPROVAL_PENDING':
      return preference.approvalPendingEnabled
    case 'SUBAGENT_DONE':
      return preference.subagentDoneEnabled
    case 'BUDGET_WARN':
      return preference.budgetWarnEnabled
    case 'SCHEDULED_TASK_PAUSED':
    case 'TRIGGER_DISABLED':
    case 'WATCHER_DISABLED':
    case 'TOKEN_DISABLED':
    case 'WEIXIN_REPLY_WINDOW_CLOSED':
    case 'DAILY_DIGEST':
      return true
    case 'OPEN_API_CALL_FAILED':
      return preference.openApiCallFailedEnabled
    default:
      return false
  }
}

/** 是否处于「该弹系统通知」的窗口状态（文档锁定这个表达式，避免各处置口径不一致）。 */
export function isInboxNotifyWindowHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.hidden || !document.hasFocus()
}

function desktopNotifyApi() {
  const api = (window as any).electronAPI
  return api && typeof api.desktopNotify === 'function' ? api : null
}

/**
 * 建立已知条目基线（打开抽屉 / 首次加载列表后调用）。
 * 未初始化时不弹任何通知：历史存量条目不得在登录后被当成「新增」。
 *
 * 语义说明：抽屉里每次 items 变化都会播种当前列表为已知，因此用户在主动浏览
 * 收件箱期间到来的新条目只进徽标、不弹系统通知（用户正在看，属预期取舍）。
 */
export function primeInboxSystemNotify(items: InboxItem[]): void {
  knownIds = new Set(items.map((item) => String(item.id)))
  primed = true
}

/**
 * 注册通知点击回传与 dock 角标联动（幂等，模块级单例）。
 * 点击：主进程负责 show/focus 窗口，这里只做路由跳转（openSessionFromNotification 原样复用）。
 * 角标：收件箱未读数（服务端权威口径）→ macOS dock badge；0 清空；win/linux 主进程 no-op。
 */
function ensureDesktopNotifyBridge(): void {
  if (bridgeSetup) return
  const api = desktopNotifyApi()
  if (!api) return
  bridgeSetup = true

  if (typeof api.onDesktopNotificationClick === 'function') {
    api.onDesktopNotificationClick((payload: { itemId?: number; sessionId?: number | null }) => {
      const sessionId = payload?.sessionId
      if (sessionId == null) return
      void openSessionFromNotification(sessionId)
    })
  }

  if (typeof api.desktopBadge === 'function') {
    const inboxStore = useInboxStore()
    watch(
      () => inboxStore.unreadCount,
      (count) => {
        void api.desktopBadge(count)
      },
      { immediate: true }
    )
  }
}

/** 供 useStreamWS 的 `inbox_updated` 分支调用。 */
export async function notifyInboxSystemUpdate(): Promise<void> {
  const api = desktopNotifyApi()
  // 非 Electron（Web/安卓）：无主进程通知通道，整体不弹
  if (!api) return
  ensureDesktopNotifyBridge()
  if (!isInboxNotifyWindowHidden()) return

  const inboxStore = useInboxStore()
  // 尚未建立基线（用户还没打开过抽屉）：本轮只播种，不弹历史通知。
  // 用 peek（不写 items）取数：不能走 fetchList——那会触发抽屉 watcher 抢先播种，
  // 使下面的 diff 恒为空（BUG-6：系统通知在真实链路下永不触发）。
  // peek 返回 null 表示拉取失败：沿用现有基线静默结束本轮，不清空也不误播种。
  const items = await inboxStore.peekInboxFirstPage()
  if (items == null) return
  if (!primed) {
    primeInboxSystemNotify(items)
    return
  }

  const fresh = items.filter((item) => !knownIds.has(String(item.id)))
  primeInboxSystemNotify(items)

  // 只弹没弹过的：基线只覆盖第一页，跨页新增若只看基线会被重复弹一次，
  // 这里用单调累积的已弹集合兜住（同一条目无论翻页多少次只通知一次）。
  const unseen = fresh.filter((item) => !notifiedIds.has(String(item.id)))
  if (unseen.length === 0) return
  for (const item of unseen) notifiedIds.add(String(item.id))

  // 系统通知总开关（与 kind 级开关独立，二者都要过）：用户关闭后一律不弹，
  // 只保留站内徽标。
  if (!inboxStore.preference.systemNotifyEnabled) return

  const eligible = unseen.filter((item) => isInboxKindEnabled(item.kind, inboxStore.preference))
  for (const item of eligible) {
    try {
      await api.desktopNotify({
        title: item.title,
        body: item.content ?? '',
        tag: `mao-inbox-${item.id}`,
        itemId: item.id,
        sessionId: item.sessionId ?? null,
      })
    } catch {
      // 系统通知失败不影响站内徽标（降级路径）
    }
  }
}

async function openSessionFromNotification(sessionId: number): Promise<void> {
  const sessionStore = useSessionStore()
  const session = await sessionStore.fetchSession(String(sessionId))
  if (!session) return
  sessionStore.setActiveSession(String(sessionId))
  const { default: router } = await import('../router')
  await router.push(`/tasks/${sessionId}`)
}

/** 测试辅助：重置模块级基线与桥接注册标记。 */
export function resetInboxSystemNotifyForTest(): void {
  knownIds = new Set<string>()
  notifiedIds = new Set<string>()
  primed = false
  bridgeSetup = false
}

/** 组件侧入口：仅在 Electron 下有意义，Web/安卓直接空转。 */
export function useInboxSystemNotify() {
  onScopeDispose(() => undefined)
  return { primeInboxSystemNotify, notifyInboxSystemUpdate }
}
