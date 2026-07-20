/** Shared Chinese labels for backend enum codes shown in admin UI. */

const EXECUTION_MODE_LABELS: Record<string, string> = {
  CLOUD: '云端',
  LOCAL: '本地'
}

const PHASE_LABELS: Record<string, string> = {
  IDLE: '空闲',
  RUNNING: '运行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  WAITING_APPROVAL: '待审批'
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: '活跃',
  ARCHIVED: '已归档'
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

export function phaseLabel(code: string | null | undefined): string {
  return labelOf(PHASE_LABELS, code)
}

export function sessionStatusLabel(code: string | null | undefined): string {
  return labelOf(SESSION_STATUS_LABELS, code)
}

export function auditActionLabel(code: string | null | undefined): string {
  return labelOf(AUDIT_ACTION_LABELS, code)
}

export const EXECUTION_MODE_OPTIONS = [
  { label: '云端', value: 'CLOUD' },
  { label: '本地', value: 'LOCAL' }
]

export const PHASE_OPTIONS = [
  { label: '空闲', value: 'IDLE' },
  { label: '运行中', value: 'RUNNING' },
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
