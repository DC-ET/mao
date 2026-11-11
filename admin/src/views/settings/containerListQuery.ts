/** 容器管理列表的客户端筛选（数据已一次取全，不另发分页请求）。 */

export interface ContainerListFilterRow {
  userId: number
  agentId: number
  userName?: string | null
  agentName?: string | null
  containerName: string
  state: 'running' | 'stopped'
  tracked: boolean
  busy: boolean
}

export interface ContainerListQuery {
  keyword: string
  /** 空 = 不限。下拉清空时可能是 null。 */
  state: '' | 'running' | 'stopped' | null
  /** 空 = 不限。下拉清空时可能是 null。 */
  tracked: '' | 'tracked' | 'untracked' | null
  /** 空 = 不限。下拉清空时可能是 null。 */
  busy: '' | 'busy' | 'idle' | null
}

function opt(value: string | null | undefined): string {
  return value ?? ''
}

export function isContainerQueryActive(query: ContainerListQuery): boolean {
  return opt(query.keyword).trim() !== '' || opt(query.state) !== '' || opt(query.tracked) !== '' || opt(query.busy) !== ''
}

function keywordHit(row: ContainerListFilterRow, keyword: string): boolean {
  const q = opt(keyword).trim().toLowerCase()
  if (!q) return true
  // 纯数字按用户 ID / Agent ID 精确匹配，避免「2」经容器名命中 12、20；名称里含这个数字仍算命中。
  if (/^\d+$/.test(q)) {
    if (String(row.userId) === q || String(row.agentId) === q) return true
    return [row.userName, row.agentName].some((part) => (part ?? '').toLowerCase().includes(q))
  }
  const parts = [row.userName, row.agentName, row.containerName, `#${row.userId}`, `#${row.agentId}`]
  return parts.some((part) => (part ?? '').toLowerCase().includes(q))
}

export function filterContainerRows<T extends ContainerListFilterRow>(rows: T[], query: ContainerListQuery): T[] {
  const state = opt(query.state)
  const tracked = opt(query.tracked)
  const busy = opt(query.busy)
  return rows.filter((row) => {
    if (state !== '' && row.state !== state) return false
    if (tracked === 'tracked' && !row.tracked) return false
    if (tracked === 'untracked' && row.tracked) return false
    if (busy === 'busy' && !row.busy) return false
    if (busy === 'idle' && row.busy) return false
    return keywordHit(row, query.keyword)
  })
}

export function pageOf<T>(rows: T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, Math.floor(pageSize))
  const start = (clampPage(page, rows.length, size) - 1) * size
  return rows.slice(start, start + size)
}

/** 把页码收进有效范围；没有数据时停在第 1 页。 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  const max = Math.max(1, Math.ceil(Math.max(0, total) / size))
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), max)
}
