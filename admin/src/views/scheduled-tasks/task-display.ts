/** 定时任务执行状态在列表与详情弹窗中的统一展示（避免两处各写一份映射）。 */

export type TagType = 'primary' | 'success' | 'danger' | 'warning' | 'info'

const EXEC_STATUS_LABELS: Record<string, string> = {
  COMPLETED: '成功',
  FAILED: '失败',
  SKIPPED: '跳过',
  QUEUED: '排队中'
}

export function execStatusLabel(status: string | null | undefined): string {
  if (!status) return '-'
  return EXEC_STATUS_LABELS[status] || status
}

export function execStatusTagType(status: string | null | undefined): TagType {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'SKIPPED': return 'warning'
    case 'QUEUED': return 'primary'
    default: return 'info'
  }
}
