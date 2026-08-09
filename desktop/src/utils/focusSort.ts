import type { Session, SideTaskItem, TaskPhase } from '../stores/session'

/**
 * 聚焦模式排序的通用输入。
 * 主任务用 Session（tree* 聚合字段），边路任务用 SideTaskItem（自身字段），
 * 统一转换为 FocusCandidate 后调用 {@link sortByFocusPriority}。
 */
export interface FocusCandidate {
  id: string
  phase: TaskPhase
  unread: boolean
  updatedAt?: string
  createdAt?: string
  pendingApprovalCount: number
  pendingQuestionCount: number
  /** 任务树聚合信号（主任务 = 自身 + 边路任务；边路任务无此字段） */
  treeRunning?: boolean
  treeFailed?: boolean
}

const RUNNING_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])

/** 优先级：0=待审批/待回答，1=失败，2=运行中，3=未读，4=空闲，5=已完成（沉底）。 */
function focusPriority(c: FocusCandidate): number {
  // 先判定待用户处理（待审批/待回答），再判定失败/运行（WAITING_APPROVAL 同时属两者时按待审批）
  if (c.phase === 'WAITING_APPROVAL' || c.pendingApprovalCount > 0 || c.pendingQuestionCount > 0) return 0
  if (c.phase === 'FAILED' || c.treeFailed) return 1
  if (RUNNING_PHASES.has(c.phase) || c.treeRunning) return 2
  if (c.unread) return 3
  if (c.phase === 'COMPLETED') return 5
  return 4
}

function timeOf(c: FocusCandidate): number {
  const raw = c.updatedAt ?? c.createdAt
  if (!raw) return 0
  const t = new Date(raw).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * 聚焦模式排序：priority ASC → updatedAt/createdAt DESC → id DESC。
 * 纯函数，供左侧主任务列表与右侧边路任务列表共用。
 */
export function sortByFocusPriority(sessions: FocusCandidate[]): FocusCandidate[] {
  return [...sessions].sort((a, b) => {
    const pa = focusPriority(a)
    const pb = focusPriority(b)
    if (pa !== pb) return pa - pb
    const tb = timeOf(b)
    const ta = timeOf(a)
    if (tb !== ta) return tb - ta
    return Number(b.id) - Number(a.id)
  })
}

/** 主任务适配器：使用服务端下发的任务树聚合字段（tree*）。 */
export function sessionToFocusCandidate(s: Session): FocusCandidate {
  return {
    id: String(s.id),
    phase: s.phase,
    unread: !!s.unread || !!s.treeUnread,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
    pendingApprovalCount: s.treePendingApprovalCount ?? (s.pendingApprovalCount ?? 0),
    pendingQuestionCount: s.treePendingQuestionCount ?? (s.pendingQuestionCount ?? 0),
    treeRunning: s.treeRunning,
    treeFailed: s.treeFailed,
  }
}

/** 边路任务适配器：使用自身字段（updatedAt / pending 计数来自服务端 VO）。 */
export function sideTaskToFocusCandidate(t: SideTaskItem): FocusCandidate {
  return {
    id: String(t.id),
    phase: t.phase,
    unread: !!t.unread,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    pendingApprovalCount: t.pendingApprovalCount ?? 0,
    pendingQuestionCount: t.pendingQuestionCount ?? 0,
  }
}

/**
 * 历史折叠判定：已完成且超过 {@code days} 天无更新的任务自动折叠进「历史」区。
 * 纯函数（now 可注入），便于边界单测。
 */
export function isHistoryEligible(s: Session, days = 3, now = Date.now()): boolean {
  if (s.phase !== 'COMPLETED') return false
  const raw = s.updatedAt || s.createdAt
  if (!raw) return false
  const t = new Date(raw).getTime()
  return Number.isFinite(t) && t < now - days * 24 * 60 * 60 * 1000
}
