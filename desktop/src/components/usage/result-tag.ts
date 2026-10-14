import type { MyLlmCallRecord } from '../../api'

export interface CallResultTag {
  label: string
  type: 'success' | 'info' | 'danger'
}

/**
 * 调用结果三态：取消（用户点停止，后端按 error_message 派生 cancelled）不是失败，
 * 灰色单列一档——与管理后台调用流水、运行轨迹的「已中断」同口径。
 */
export function callResultTag(row: Pick<MyLlmCallRecord, 'success' | 'cancelled'>): CallResultTag {
  if (row.cancelled === 1) return { label: '取消', type: 'info' }
  return row.success === 1 ? { label: '成功', type: 'success' } : { label: '失败', type: 'danger' }
}
