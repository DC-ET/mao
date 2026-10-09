import { onScopeDispose, ref } from 'vue'
import type { InboxItem, InboxKind, InboxPreference } from '@mao/contracts'
import { useInboxStore } from '../stores/inbox'
import { useSessionStore } from '../stores/session'

/**
 * Electron 系统通知（P2）：窗口未聚焦 / 最小化时，把新增的收件箱条目弹成系统通知。
 *
 * 约束：
 * - 仅 Electron 生效（HTML5 Notification 在 Electron 下直接走系统通知，无需 IPC）；Web/安卓不弹。
 * - 触发条件 = `document.hidden || !document.hasFocus()`（hidden 覆盖最小化，hasFocus 覆盖可见但未聚焦）。
 * - `requestPermission()` 返回 denied 时静默降级：不弹窗、不报错，只保留站内徽标。
 * - 事件只带权威 unreadCount，通知的标题/摘要由这里拉列表后 diff 得出（不做「事件携带内容」方案）。
 */

/**
 * 模块级基线：与 useStreamWS 的单例生命周期一致，避免多组件重复弹同一条。
 * - `knownIds`：当前已知条目（打开抽屉时播种为第一页，浏览期间新条目因此不弹）。
 * - `notifiedIds`：已弹过系统通知的条目（单调累积，跨页新增不会被重复弹）。
 */
let knownIds = new Set<string>()
let primed = false
let notifiedIds = new Set<string>()

const permission = ref<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied'
)

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
    case 'TOKEN_DISABLED':
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

async function requestPermissionOnce(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') {
    permission.value = 'granted'
    return true
  }
  if (Notification.permission === 'denied') {
    permission.value = 'denied'
    return false
  }
  try {
    const result = await Notification.requestPermission()
    permission.value = result
    return result === 'granted'
  } catch {
    // macOS 首次调用可能因无用户手势被拒：静默降级，不弹窗不报错
    return false
  }
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

/** 供 useStreamWS 的 `inbox_updated` 分支调用。 */
export async function notifyInboxSystemUpdate(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'denied') return
  if (!isInboxNotifyWindowHidden()) return
  if (!(await requestPermissionOnce())) return

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
  // 只保留站内徽标。放在 requestPermissionOnce 之后，避免为不弹通知的用户
  // 无谓发起通知权限申请。
  if (!inboxStore.preference.systemNotifyEnabled) return

  const eligible = unseen.filter((item) => isInboxKindEnabled(item.kind, inboxStore.preference))
  for (const item of eligible) {
    try {
      const notification = new Notification(item.title, { body: item.content ?? '', tag: `mao-inbox-${item.id}` })
      notification.onclick = () => {
        window.focus()
        notification.close()
        const sessionId = item.sessionId
        if (sessionId == null) return
        void openSessionFromNotification(sessionId)
      }
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

/** 测试辅助：重置模块级基线。 */
export function resetInboxSystemNotifyForTest(): void {
  knownIds = new Set<string>()
  notifiedIds = new Set<string>()
  primed = false
  permission.value = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
}

/** 组件侧入口：仅在 Electron 下有意义，Web/安卓直接空转。 */
export function useInboxSystemNotify() {
  onScopeDispose(() => undefined)
  return { permission, primeInboxSystemNotify, notifyInboxSystemUpdate }
}
