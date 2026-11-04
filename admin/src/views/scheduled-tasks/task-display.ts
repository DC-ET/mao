/** 定时任务执行状态在列表与详情弹窗中的统一展示（避免两处各写一份映射）。 */

import { formatDateTime } from '../../utils/datetime'

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

/**
 * 列表把「启/停（status）+ 完结（finished）」合并为单一三态展示：
 * 完结是系统置位的终态，优先于启/停（完结后启/停开关本就禁用，不再有意义）。
 * 详情弹窗仍分开展示两个维度，信息不丢失。
 */
export function taskStateTag(task: {
  status?: string | null
  finished?: boolean | number | null
  finishedAt?: string | null
}): { label: string; type: TagType; title: string } {
  if (task.finished) {
    return {
      label: '已完结',
      type: 'info',
      title: task.finishedAt ? `完结于 ${formatDateTime(task.finishedAt)}` : '已完结'
    }
  }
  if (task.status === 'ACTIVE') {
    return { label: '启用', type: 'success', title: '任务启用中，按 cron 自动触发' }
  }
  return { label: '暂停', type: 'info', title: '任务已暂停，不会自动触发' }
}
