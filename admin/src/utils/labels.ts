/** Shared Chinese labels for backend enum codes shown in admin UI. */

const EXECUTION_MODE_LABELS: Record<string, string> = {
  CLOUD: '云端',
  LOCAL: '本地'
}

const PHASE_LABELS: Record<string, string> = {
  IDLE: '空闲',
  RUNNING: '运行中',
  RESUMING: '恢复中',
  WAITING_APPROVAL: '待审批',
  CANCELLING: '取消中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: '活跃',
  ARCHIVED: '已归档'
}

const SESSION_TYPE_LABELS: Record<string, string> = {
  NORMAL: '主会话',
  SIDE_TASK: '边路任务',
  SUBAGENT: '子代理'
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  READ: '读取',
  CREATE: '创建',
  UPDATE: '更新',
  DELETE: '删除'
}

function labelOf(map: Record<string, string>, code: string | null | undefined): string {
  if (!code) return '-'
  return map[code] || code
}

export function executionModeLabel(code: string | null | undefined): string {
  return labelOf(EXECUTION_MODE_LABELS, code)
}

/** 等待用户回答 ask_user_questions 时 phase 仍为 RUNNING，展示层据此单独覆盖为「等待回复」。 */
export function phaseLabel(
  code: string | null | undefined,
  pendingQuestionCount?: number | null
): string {
  if (code === 'RUNNING' && (pendingQuestionCount ?? 0) > 0) return '等待回复'
  return labelOf(PHASE_LABELS, code)
}

export function sessionStatusLabel(code: string | null | undefined): string {
  return labelOf(SESSION_STATUS_LABELS, code)
}

export interface SessionTypeTag {
  label: string;
  type: 'info' | 'warning';
}

/**
 * 会话类型标签：NORMAL / 缺省 → 主会话（灰），SIDE_TASK → 边路任务（橙），
 * SUBAGENT → 子代理（蓝）。三种类型都着标签，列表里每一行都有明确类型；
 * 未知类型按原值展示，不静默吞掉。
 */
export function sessionTypeTag(code: string | null | undefined): SessionTypeTag {
  if (code === 'SIDE_TASK') return { label: SESSION_TYPE_LABELS.SIDE_TASK, type: 'warning' };
  if (code === 'SUBAGENT') return { label: SESSION_TYPE_LABELS.SUBAGENT, type: 'info' };
  if (code === 'NORMAL') return { label: SESSION_TYPE_LABELS.NORMAL, type: 'info' };
  return { label: code ?? SESSION_TYPE_LABELS.NORMAL, type: 'info' };
}

export function auditActionLabel(code: string | null | undefined): string {
  return labelOf(AUDIT_ACTION_LABELS, code)
}

export const EXECUTION_MODE_OPTIONS = [
  { label: '云端', value: 'CLOUD' },
  { label: '本地', value: 'LOCAL' }
]

/** 管理端会话检索范围：默认只看对话双方，工具输出量大时按需放宽。 */
export const SEARCH_SCOPE_OPTIONS = [
  { label: '仅对话消息', value: 'CONVERSATION' },
  { label: '全部消息（含工具输出）', value: 'ALL' }
]

export const PHASE_OPTIONS = [
  { label: '空闲', value: 'IDLE' },
  { label: '运行中', value: 'RUNNING' },
  { label: '待审批', value: 'WAITING_APPROVAL' },
  { label: '已完成', value: 'COMPLETED' },
  { label: '失败', value: 'FAILED' },
  { label: '已取消', value: 'CANCELLED' }
]

export const RUNTIME_PHASE_OPTIONS = [
  { label: '运行中', value: 'RUNNING' },
  { label: '待审批', value: 'WAITING_APPROVAL' },
  { label: '失败', value: 'FAILED' },
  { label: '已取消', value: 'CANCELLED' }
]

export const SESSION_STATUS_OPTIONS = [
  { label: '活跃', value: 'ACTIVE' },
  { label: '已归档', value: 'ARCHIVED' }
]

export const AUDIT_ACTION_OPTIONS = [
  { label: '读取', value: 'READ' },
  { label: '创建', value: 'CREATE' },
  { label: '更新', value: 'UPDATE' },
  { label: '删除', value: 'DELETE' }
]
