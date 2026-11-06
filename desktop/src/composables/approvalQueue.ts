import { ref } from 'vue'
import type { ApprovalHint } from '@mao/contracts'
import { useSessionStore } from '../stores/session'

/**
 * 多端审批（技术方案 2026-11-06）的前端状态：
 * - 卡片队列（执行端本地 IPC 卡 + WS 广播卡按 requestId 去重）
 * - 投票 / 已本地放行 / 等回声的标记
 *
 * 独立成模块是为了让 `useStreamWS` 与 `useChat` 都能引用同一份状态，
 * 同时避免两者互相 import 形成环（`useChat` 已依赖 `useStreamWS`）。
 */
export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  sessionId?: string
  dangerReason?: string
  /** 服务端生成的「总是允许」hint；缺省 = 不可规则化，卡片只有两按钮 */
  approvalHint?: ApprovalHint
  /** local = Electron 主进程 IPC；remote = WS 广播（多端审批） */
  source?: 'local' | 'remote'
  /** 远端卡片展示「在 xxx 上执行」；执行端本地卡没有 */
  deviceName?: string
}

/** 投票后等回声：5s 未到且连接在线则重发同一帧，最多 2 次（技术方案 §4.5-6）。 */
export const APPROVAL_ECHO_RETRY_MS = 5000
export const APPROVAL_ECHO_MAX_RETRIES = 2
/** 投票标记只用于挡住「回声未到之前的重复插入」，超过上限按插入序淘汰即可。 */
const VOTED_ID_LIMIT = 500

export interface AwaitingEchoRegistration {
  sessionId: string
  approved: boolean
  alwaysAllow: boolean
  /** 重发同一票；返回是否成功入发送队列 */
  resend: () => Promise<boolean>
}

interface AwaitingEchoEntry extends AwaitingEchoRegistration {
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

export const pendingApprovals = ref<ApprovalItem[]>([])
const votedIds = new Set<string>()
const locallyReleased = new Set<string>()
const awaitingEcho = new Map<string, AwaitingEchoEntry>()
let approvalRelaySupported = false

/** 服务端 connected 帧声明了 approvalRelay 才等回声；旧后端直接按本地选择放行。 */
export function isApprovalRelaySupported(): boolean {
  return approvalRelaySupported
}

export function setApprovalRelaySupported(supported: boolean): void {
  approvalRelaySupported = supported
}

export function isApprovalVoted(requestId: string): boolean {
  return votedIds.has(requestId)
}

export function markApprovalVoted(requestId: string): void {
  votedIds.add(requestId)
  if (votedIds.size > VOTED_ID_LIMIT) {
    const oldest = votedIds.values().next()
    if (!oldest.done) votedIds.delete(oldest.value)
  }
}

export function clearApprovalVoted(requestId: string): void {
  votedIds.delete(requestId)
}

export function wasLocallyReleased(requestId: string): boolean {
  return locallyReleased.has(requestId)
}

export function markLocallyReleased(requestId: string): void {
  locallyReleased.add(requestId)
  if (locallyReleased.size > VOTED_ID_LIMIT) {
    const oldest = locallyReleased.values().next()
    if (!oldest.done) locallyReleased.delete(oldest.value)
  }
}

export function clearLocallyReleased(requestId: string): void {
  locallyReleased.delete(requestId)
}

export function findPendingApproval(requestId: string): ApprovalItem | undefined {
  return pendingApprovals.value.find((item) => item.requestId === requestId)
}

/**
 * 入队（按 requestId 去重）。
 * - 已投过票的 id 直接丢弃：投票后卡片已移除，晚到的 IPC 卡 / 订阅重放不能把它插回来。
 * - 同 id 本地 IPC 卡晚到：用主进程的描述覆盖远端摘要（主进程口径更精确）。
 * @returns 是否新插入（调用方据此决定是否递增会话计数）
 */
export function upsertApproval(item: ApprovalItem): boolean {
  if (votedIds.has(item.requestId)) return false
  const index = pendingApprovals.value.findIndex((a) => a.requestId === item.requestId)
  if (index >= 0) {
    const existing = pendingApprovals.value[index]
    if (item.source === 'local' && existing.source === 'remote') {
      pendingApprovals.value[index] = {
        ...existing,
        description: item.description,
        toolName: item.toolName || existing.toolName,
        source: 'local',
        deviceName: undefined,
      }
    }
    return false
  }
  pendingApprovals.value.push(item)
  if (item.sessionId) {
    useSessionStore().incrementPendingApproval(item.sessionId)
  }
  return true
}

/** 出队（含会话计数递减）。 */
export function removeApproval(requestId: string): ApprovalItem | undefined {
  const index = pendingApprovals.value.findIndex((a) => a.requestId === requestId)
  if (index < 0) return undefined
  const [item] = pendingApprovals.value.splice(index, 1)
  if (item.sessionId) {
    useSessionStore().decrementPendingApproval(item.sessionId)
  }
  return item
}

/** 取走匹配的卡片（清空队列时用，计数统一在这里递减）。 */
export function takePendingApprovals(onlySessionId?: string | null): ApprovalItem[] {
  const taken = onlySessionId != null
    ? pendingApprovals.value.filter((item) => item.sessionId === onlySessionId)
    : pendingApprovals.value.slice()
  if (taken.length === 0) return taken
  const takenIds = new Set(taken.map((item) => item.requestId))
  pendingApprovals.value = pendingApprovals.value.filter((item) => !takenIds.has(item.requestId))
  const sessionStore = useSessionStore()
  for (const item of taken) {
    if (item.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
  }
  return taken
}

export function getPendingApprovals(): ApprovalItem[] {
  return pendingApprovals.value
}

function scheduleEchoRetry(requestId: string, entry: AwaitingEchoEntry): void {
  entry.timer = setTimeout(() => {
    if (awaitingEcho.get(requestId) !== entry) return
    if (entry.attempts >= APPROVAL_ECHO_MAX_RETRIES) return
    entry.attempts += 1
    void entry.resend().catch(() => false)
    scheduleEchoRetry(requestId, entry)
  }, APPROVAL_ECHO_RETRY_MS)
}

/** 投票已发出，等 resolved 回来放行；期间按 §4.5-6 定时重发。 */
export function registerApprovalEcho(requestId: string, registration: AwaitingEchoRegistration): void {
  resolveApprovalEcho(requestId)
  const entry: AwaitingEchoEntry = { ...registration, attempts: 0, timer: null }
  awaitingEcho.set(requestId, entry)
  scheduleEchoRetry(requestId, entry)
}

export function resolveApprovalEcho(requestId: string): void {
  const entry = awaitingEcho.get(requestId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  awaitingEcho.delete(requestId)
}

/** 重连成功后立即补发一次（技术方案 §4.5-6）。 */
export function replayApprovalEcho(): void {
  for (const entry of awaitingEcho.values()) {
    void entry.resend().catch(() => false)
  }
}

/**
 * 收走匹配的等待项（清定时器）。用于会话终态 / 清空会话时按拒绝兜底放行。
 * @returns 被收走的 requestId 列表，调用方负责走解锁入口。
 */
export function drainApprovalEcho(predicate: (entry: AwaitingEchoRegistration) => boolean): string[] {
  const drained: string[] = []
  for (const [requestId, entry] of [...awaitingEcho]) {
    if (!predicate(entry)) continue
    if (entry.timer) clearTimeout(entry.timer)
    awaitingEcho.delete(requestId)
    drained.push(requestId)
  }
  return drained
}

export function hasApprovalEcho(requestId: string): boolean {
  return awaitingEcho.has(requestId)
}

/** 仅供单测复位模块级状态。 */
export function resetApprovalQueueForTest(): void {
  for (const entry of awaitingEcho.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  awaitingEcho.clear()
  pendingApprovals.value = []
  votedIds.clear()
  locallyReleased.clear()
  approvalRelaySupported = false
}

export function useApprovalQueue() {
  return {
    pendingApprovals,
    upsertApproval,
    removeApproval,
    takePendingApprovals,
  }
}
