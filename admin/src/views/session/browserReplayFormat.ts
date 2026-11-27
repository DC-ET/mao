import type { BrowserReplayListItem } from '@mao/contracts'
import { activityRangeParams } from '../../utils/sessionActivityRange'

/**
 * 管理后台「浏览器回放」列表的纯逻辑（技术方案 2026-11-27 §5.2）：
 * 状态徽标、时长/体积/时间格式化、筛选参数序列化、提示文案。
 * 无 DOM / 无请求依赖，便于 vitest 单测；组件只负责渲染与取数。
 */

/** el-tag 的语义色子集（回放状态只用这三种）。 */
export type ReplayTagType = 'success' | 'warning' | 'danger'

export interface ReplayStatusTag {
  label: string
  type: ReplayTagType
}

/**
 * 状态列徽标：未正常结束（崩溃/超时未结算，endedAt=null）与已截断（体积上限/写入故障）可叠加，
 * 两者都无才是「正常」。与桌面端 BrowserLiveReplay 的两枚徽标同口径。
 */
export function replayStatusTags(item: Pick<BrowserReplayListItem, 'endedAt' | 'truncated'>): ReplayStatusTag[] {
  const tags: ReplayStatusTag[] = []
  if (item.endedAt == null) tags.push({ label: '未正常结束', type: 'warning' })
  if (item.truncated) tags.push({ label: '已截断', type: 'danger' })
  if (tags.length === 0) tags.push({ label: '正常', type: 'success' })
  return tags
}

/** 时长列：未结算场（durationMs=null）展示「未结束」，不读 timeline 兜底（§13）。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '未结束'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

/** 体积列（manifest approxBytes）。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes == null || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const replayTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

/** 列表项时间是 epoch ms：按北京时间格式化为 YYYY-MM-DD HH:mm:ss（与 utils/datetime 口径一致）。 */
export function formatReplayTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '-'
  const parts = replayTimeFormatter.formatToParts(new Date(ts))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** 会话标题列：缺失标题（未命名会话）回落为「会话 #id」，点击仍可跳详情。 */
export function replaySessionTitle(item: Pick<BrowserReplayListItem, 'sessionId' | 'sessionTitle'>): string {
  return item.sessionTitle || `会话 #${item.sessionId}`
}

/** 列表筛选状态（含 ?sessionId= 深链，见 §5.4）。 */
export interface BrowserReplayFilters {
  userId: number | null
  agentId: number | null
  sessionId: number | null
  keyword: string
  /** 活跃时间档位 1D/3D/7D/30D/90D/CUSTOM/ALL，口径同会话列表。 */
  activityRange: string
  activityCustomRange: [string, string] | null
}

/** 筛选状态 → 请求参数：空值不下发（交给后端默认 7D 兜底），自定义档转 dateFrom/dateTo。 */
export function replayListParams(
  filters: BrowserReplayFilters,
  page: number,
  size: number
): Record<string, string | number> {
  const params: Record<string, string | number> = { page, size }
  if (filters.userId) params.userId = filters.userId
  if (filters.agentId) params.agentId = filters.agentId
  if (filters.sessionId) params.sessionId = filters.sessionId
  const keyword = filters.keyword.trim()
  if (keyword) params.keyword = keyword
  Object.assign(params, activityRangeParams(filters.activityRange, filters.activityCustomRange))
  return params
}

/** 顶部固定提示：跨用户查看高敏 + LOCAL 录制不可见（§5.2 / §7）。 */
export const BROWSER_REPLAY_SENSITIVE_NOTICE =
  '回放可能包含登录态敏感信息，访问会记录审计；LOCAL 会话的录制保存在用户设备上，管理端不可见'

/** 候选/manifest 读取超限的后端提示（不静默截断，§4.3）。 */
export const BROWSER_REPLAY_TRUNCATED_TIP = '候选过多，请缩小时间/用户范围'

export function browserReplayTruncatedTip(truncated: boolean | undefined): string | null {
  return truncated ? BROWSER_REPLAY_TRUNCATED_TIP : null
}

/** 清理保留天数默认值（harness.cleanup.browserReplayTtlDays，钳制 0–365、非法回退 7）。 */
export const BROWSER_REPLAY_TTL_DAYS_DEFAULT = 7

/** 空态引导：录制开关路径 + 保留天数 + 仅云端可见（§5.2）。 */
export function browserReplayEmptyHint(ttlDays: number = BROWSER_REPLAY_TTL_DAYS_DEFAULT): string {
  return (
    `暂无回放。开启路径：系统设置 → 浏览器直播 → 启用操作录制，开启后新的浏览器操作会自动落盘；` +
    `录制默认保留 ${ttlDays} 天（harness.cleanup.browserReplayTtlDays），仅云端（CLOUD）会话的录制在管理端可见。`
  )
}

/** 单场 timeline 拉取 404（已被清理 / 从未录制）时的兜底文案（§5.3）。 */
export const BROWSER_REPLAY_MISSING_TEXT = '回放已被清理或不存在'
