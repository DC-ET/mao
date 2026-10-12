/**
 * 每日运营摘要 payload 解析与展示格式化（桌面端）。
 *
 * 数据来自收件箱条目的 `payload.digest`（后端 digest 域聚合结果原样透传），
 * 但 payload 过的是 JSON 边界且类型是 Record<string, unknown>：这里做一次
 * 防御性解析，形状不符一律返回 null（对话框降级提示，不白屏、不抛）。
 */

export interface DigestFailedTask {
  sessionId: number | null
  title: string
  reason: string
}

export interface DigestPausedTask {
  taskId: number | null
  name: string
}

export interface DigestDisabledWatcher {
  watcherId: number | null
  name: string
}

export interface DigestApprovalItem {
  sessionId: number | null
  title: string
}

export interface DigestCostAgent {
  agentId: number | null
  name: string
  micros: number
}

export interface DigestTasks {
  completed: number
  failed: number
  failedTop: DigestFailedTask[]
}

export interface DigestScheduled {
  total: number
  completed: number
  failed: number
  paused: DigestPausedTask[]
}

export interface DigestWatchers {
  triggered: number
  disabled: DigestDisabledWatcher[]
}

export interface DigestApprovals {
  pending: number
  items: DigestApprovalItem[]
}

export interface DigestCost {
  totalMicros: number
  unpricedCalls: number
  top: DigestCostAgent[]
}

export interface DigestOpenApi {
  total: number
  rejected: number
}

export interface DigestData {
  coveredDate: string
  tasks: DigestTasks | null
  scheduled: DigestScheduled | null
  watchers: DigestWatchers | null
  approvals: DigestApprovals | null
  cost: DigestCost | null
  openApi: DigestOpenApi | null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numOr0(value: unknown): number {
  return num(value) ?? 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numOrNull(value: unknown): number | null {
  return num(value)
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseTasks(value: unknown): DigestTasks | null {
  const o = obj(value)
  if (o == null) return null
  return {
    completed: numOr0(o.completed),
    failed: numOr0(o.failed),
    failedTop: arr(o.failedTop).map((raw) => {
      const item = obj(raw) ?? {}
      return {
        sessionId: numOrNull(item.sessionId),
        title: str(item.title),
        reason: str(item.reason),
      }
    }),
  }
}

function parseScheduled(value: unknown): DigestScheduled | null {
  const o = obj(value)
  if (o == null) return null
  return {
    total: numOr0(o.total),
    completed: numOr0(o.completed),
    failed: numOr0(o.failed),
    paused: arr(o.paused).map((raw) => {
      const item = obj(raw) ?? {}
      return { taskId: numOrNull(item.taskId), name: str(item.name) }
    }),
  }
}

function parseWatchers(value: unknown): DigestWatchers | null {
  const o = obj(value)
  if (o == null) return null
  return {
    triggered: numOr0(o.triggered),
    disabled: arr(o.disabled).map((raw) => {
      const item = obj(raw) ?? {}
      return { watcherId: numOrNull(item.watcherId), name: str(item.name) }
    }),
  }
}

function parseApprovals(value: unknown): DigestApprovals | null {
  const o = obj(value)
  if (o == null) return null
  return {
    pending: numOr0(o.pending),
    items: arr(o.items).map((raw) => {
      const item = obj(raw) ?? {}
      return { sessionId: numOrNull(item.sessionId), title: str(item.title) }
    }),
  }
}

function parseCost(value: unknown): DigestCost | null {
  const o = obj(value)
  if (o == null) return null
  return {
    totalMicros: numOr0(o.totalMicros),
    unpricedCalls: numOr0(o.unpricedCalls),
    top: arr(o.top).map((raw) => {
      const item = obj(raw) ?? {}
      return {
        agentId: numOrNull(item.agentId),
        name: str(item.name),
        micros: numOr0(item.micros),
      }
    }),
  }
}

function parseOpenApi(value: unknown): DigestOpenApi | null {
  const o = obj(value)
  if (o == null) return null
  return { total: numOr0(o.total), rejected: numOr0(o.rejected) }
}

/**
 * 从收件箱条目 payload 解析摘要数据。
 * 返回 null 的两种情形：payload 缺失 / `digest` 字段缺失 / coveredDate 不是字符串
 * （旧格式或损坏数据——对话框据此显示降级提示）。
 */
export function parseDigestData(payload: Record<string, unknown> | null): DigestData | null {
  if (payload == null) return null
  const raw = obj(payload.digest)
  if (raw == null) return null
  const coveredDate = raw.coveredDate
  if (typeof coveredDate !== 'string' || coveredDate === '') return null
  return {
    coveredDate,
    tasks: parseTasks(raw.tasks),
    scheduled: parseScheduled(raw.scheduled),
    watchers: parseWatchers(raw.watchers),
    approvals: parseApprovals(raw.approvals),
    cost: parseCost(raw.cost),
    openApi: parseOpenApi(raw.openApi),
  }
}

/** '2026-10-11' → '10-11'（标题 / 状态行用的短日期）。 */
export function shortDate(coveredDate: string): string {
  return coveredDate.slice(5)
}

/** micros（×10⁶ 整数）→ '¥x.xx'，保留两位小数（用量页同口径）。 */
export function formatDigestCost(micros: number): string {
  if (!Number.isFinite(micros)) return '¥0.00'
  return `¥${(micros / 1_000_000).toFixed(2)}`
}
