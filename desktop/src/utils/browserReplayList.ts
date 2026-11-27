/**
 * 设置页「浏览器回放」列表的纯逻辑（技术方案 2026-11-27 §6.2）：时间范围档位 → 时间窗 /
 * 请求参数、CLOUD + LOCAL 两路数据合并去重排序、模式/关键词筛选、客户端分页、
 * 初始场次匹配（initialLiveId）与展示格式化。
 *
 * 全部纯函数、零 DOM / 零 IO：node 环境 vitest 可直接单测（desktop 无组件测试框架，
 * 视图层只做装配，逻辑必须落在这里）。
 * 时间口径与后端 resolveActivityWindow 对齐：Asia/Shanghai 日历日，不依赖宿主机时区。
 */
import type { BrowserReplayListItem } from '@mao/contracts'

// ---------- 时间范围 ----------

/** 档位与后端 ACTIVITY_RANGE_PRESET_DAYS 预设集一致；CUSTOM 走 dateFrom/dateTo。 */
export type BrowserReplayRange = '1D' | '3D' | '7D' | '30D' | '90D' | 'CUSTOM' | 'ALL'

/** 页面默认档：与 owner 接口后端默认 30D 同口径（后端常量默认是 7D，须显式传 30D）。 */
export const BROWSER_REPLAY_RANGE_DEFAULT: BrowserReplayRange = '30D'

export const BROWSER_REPLAY_RANGE_OPTIONS: Array<{ value: BrowserReplayRange; label: string }> = [
  { value: '1D', label: '最近 1 天' },
  { value: '3D', label: '最近 3 天' },
  { value: '7D', label: '最近 7 天' },
  { value: '30D', label: '最近 30 天' },
  { value: '90D', label: '最近 90 天' },
  { value: 'CUSTOM', label: '自定义' },
  { value: 'ALL', label: '全部时间' },
]

const RANGE_PRESET_DAYS: Record<string, number> = { '1D': 1, '3D': 3, '7D': 7, '30D': 30, '90D': 90 }
/** Asia/Shanghai 固定 UTC+8（无夏令时），与后端 process-timezone 钉死的口径一致。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** 上海时区当天 YYYY-MM-DD（Intl 取 parts，避免 toISOString 的 UTC 日界漂移）。 */
export function shanghaiTodayYmd(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** YYYY-MM-DD 按日历加减天数（UTC 数学，不做时区换算）。 */
export function shiftYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day + days))
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(utc.getUTCDate()).padStart(2, '0')
  return `${utc.getUTCFullYear()}-${mm}-${dd}`
}

/** 只认真实存在的日历日（防 2026-02-30 / 2026-13-01 之类）。 */
export function isValidYmd(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

/** 上海时区该日历日 00:00 的 epoch ms。 */
export function ymdStartMs(ymd: string): number {
  const [year, month, day] = ymd.split('-').map(Number)
  return Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS
}

/** 「自定义」档位的初始区间：最近 30 天（含今天），与页面默认档一致。 */
export function defaultCustomRange(now: Date = new Date()): [string, string] {
  const today = shanghaiTodayYmd(now)
  return [shiftYmd(today, -(Number(RANGE_PRESET_DAYS[BROWSER_REPLAY_RANGE_DEFAULT]) - 1)), today]
}

/** 时间窗（epoch ms，闭区间）：null = 该侧无界。ALL 全无界；CUSTOM 缺合法日期时回落默认档。 */
export function resolveReplayWindow(
  range: string,
  custom: [string, string] | null,
  now: Date = new Date(),
): { from: number | null; to: number | null } {
  if (range === 'ALL') return { from: null, to: null }
  const presetDays = RANGE_PRESET_DAYS[range]
  let fromDay: string | null = null
  let toDay: string | null = null
  if (range === 'CUSTOM') {
    const rawFrom = custom?.[0] ?? ''
    const rawTo = custom?.[1] ?? ''
    if (isValidYmd(rawFrom) && isValidYmd(rawTo)) {
      fromDay = rawFrom <= rawTo ? rawFrom : rawTo
      toDay = rawFrom <= rawTo ? rawTo : rawFrom
    }
  }
  if (fromDay == null || toDay == null) {
    const days = presetDays ?? RANGE_PRESET_DAYS[BROWSER_REPLAY_RANGE_DEFAULT]
    const today = shanghaiTodayYmd(now)
    fromDay = shiftYmd(today, -(days - 1))
    toDay = today
  }
  return { from: ymdStartMs(fromDay), to: ymdStartMs(toDay) + DAY_MS - 1 }
}

/** 筛选状态 → CLOUD 列表请求参数：预设档只发 range，自定义才发日期（后端同口径解析）。 */
export function replayRangeParams(
  range: string,
  custom: [string, string] | null,
): { range?: string; dateFrom?: string; dateTo?: string } {
  if (range === 'ALL') return { range: 'ALL' }
  if (range === 'CUSTOM') {
    const from = isValidYmd(custom?.[0]) ? custom[0] : ''
    const to = isValidYmd(custom?.[1]) ? custom[1] : ''
    if (!from && !to) return { range: BROWSER_REPLAY_RANGE_DEFAULT }
    return { ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}) }
  }
  return { range: RANGE_PRESET_DAYS[range] ? range : BROWSER_REPLAY_RANGE_DEFAULT }
}

// ---------- 两路数据合并 ----------

/** Electron IPC 本机扫描行（electron.d.ts BrowserReplayListAllRow 的渲染层镜像）。 */
export interface LocalReplayRow {
  sessionId: number
  liveId: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  frameCount: number
  approxBytes: number
  truncated: boolean
  pageUrl: string
}

/** LOCAL 行的会话元数据（按 sessionId 批量 GET /v1/sessions/:id 补齐；null = 取不到/已删除）。 */
export interface LocalSessionMeta {
  title?: string | null
  agentId?: number | null
  agentName?: string | null
}

/**
 * GET /v1/sessions/:id 原始返回 → LOCAL 行元数据。字段缺失 / 空串 / 非对象一律归一为 null
 * （标题为空串不展示空白，回落「会话 #id（已删除）」）；agentId 兼容后端 string 形态 id。
 */
export function normalizeLocalSessionMeta(raw: unknown): LocalSessionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const session = raw as { title?: unknown; agentId?: unknown; agentName?: unknown }
  let agentId: number | null = null
  if (typeof session.agentId === 'number' && Number.isFinite(session.agentId)) agentId = session.agentId
  else if (typeof session.agentId === 'string' && session.agentId.trim() !== '' && Number.isFinite(Number(session.agentId))) {
    agentId = Number(session.agentId)
  }
  return {
    title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title : null,
    agentId,
    agentName: typeof session.agentName === 'string' && session.agentName.trim() !== '' ? session.agentName : null,
  }
}

/** 合并去重键：sessionId + liveId + executionMode（同一场不会同时在两端，仍按方案口径去重）。 */
export function replayRowKey(sessionId: number, liveId: string, executionMode: string): string {
  return `${sessionId}:${liveId}:${executionMode}`
}

// ---------- LOCAL 行归属探测 ----------

/**
 * LOCAL 元数据探测的「非本人」哨兵：会话存在但不归属当前用户。共用设备上他人账号遗留的
 * 本机录制会出现在 runtime 目录扫描里（方案 §7 越权枚举），必须整行剔除，不能与
 * 「已删除」混为一谈（后者保留占位行）。
 */
export const LOCAL_META_FOREIGN = 'foreign' as const;

/** LOCAL 行元数据探测结果：null = 取不到（已删除 / 网络失败，保留占位行）；哨兵 = 非本人，剔行。 */
export type LocalMetaOutcome = LocalSessionMeta | null | typeof LOCAL_META_FOREIGN;

/** axios 错误 → HTTP 状态码（取不到返回 0）。 */
export function httpStatusOf(error: unknown): number {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return typeof status === 'number' ? status : 0;
}

/**
 * GET /v1/sessions/:id 失败 → 归属判定（该接口对非归属会话返回 403 FORBIDDEN）：
 * 403 → 非本人（剔行）；404（已删除）/ 网络故障 → null（标题回落「会话 #id（已删除）」）。
 */
export function localMetaOutcomeFromError(error: unknown): LocalMetaOutcome {
  return httpStatusOf(error) === 403 ? LOCAL_META_FOREIGN : null;
}

/**
 * CLOUD（后端已带标题/Agent）+ LOCAL（本机 IPC，标题/Agent 由 localMeta 补齐）合并：
 * 去重后按 startedAt 倒序、liveId 倒序（与服务端排序口径一致）。
 * CLOUD 先入栈，重复键以 CLOUD 行为准。
 */
export function mergeReplayRows(
  cloud: BrowserReplayListItem[],
  local: LocalReplayRow[],
  localMeta: Map<number, LocalSessionMeta | null> = new Map(),
): BrowserReplayListItem[] {
  const merged: BrowserReplayListItem[] = []
  const seen = new Set<string>()
  for (const item of cloud) {
    const key = replayRowKey(item.sessionId, item.liveId, item.executionMode)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  for (const row of local) {
    const key = replayRowKey(row.sessionId, row.liveId, 'LOCAL')
    if (seen.has(key)) continue
    seen.add(key)
    const meta = localMeta.get(row.sessionId) ?? null
    merged.push({
      sessionId: row.sessionId,
      liveId: row.liveId,
      executionMode: 'LOCAL',
      sessionTitle: meta?.title ?? null,
      agentId: meta?.agentId ?? null,
      agentName: meta?.agentName ?? null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      frameCount: row.frameCount,
      approxBytes: row.approxBytes,
      truncated: row.truncated,
      pageUrl: row.pageUrl,
    })
  }
  return merged.sort(compareReplayRows)
}

/** startedAt 倒序；同刻按 liveId（L<ms>）数值倒序，保证与服务端排序稳定一致。 */
export function compareReplayRows(a: BrowserReplayListItem, b: BrowserReplayListItem): number {
  if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
  return Number(b.liveId.slice(1)) - Number(a.liveId.slice(1))
}

// ---------- 筛选 / 分页 ----------

export type BrowserReplayModeFilter = 'ALL' | 'CLOUD' | 'LOCAL'

export const BROWSER_REPLAY_MODE_OPTIONS: Array<{ value: BrowserReplayModeFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'CLOUD', label: 'CLOUD（云端）' },
  { value: 'LOCAL', label: 'LOCAL（本机）' },
]

/** 模式 + 关键词（会话标题，客户端过滤已合并列表）；关键词大小写不敏感、前后空白忽略。 */
export function filterReplayRows(
  rows: BrowserReplayListItem[],
  options: { mode?: BrowserReplayModeFilter; keyword?: string } = {},
): BrowserReplayListItem[] {
  const mode = options.mode ?? 'ALL'
  const keyword = (options.keyword ?? '').trim().toLowerCase()
  return rows.filter((row) => {
    if (mode !== 'ALL' && row.executionMode !== mode) return false
    if (!keyword) return true
    return (row.sessionTitle ?? '').toLowerCase().includes(keyword)
  })
}

/** 客户端分页（合并后才分页）：page/size 非法时收敛到合法区间。 */
export function paginateReplayRows<T>(rows: T[], page: number, size: number): T[] {
  const safeSize = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 20
  const maxPage = Math.max(1, Math.ceil(rows.length / safeSize))
  const safePage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), maxPage) : 1
  return rows.slice((safePage - 1) * safeSize, safePage * safeSize)
}

// ---------- initialLiveId 匹配 ----------

/**
 * 列表加载完成后按 liveId 匹配初始场次：命中返回该项（调用方 open），未命中 / 无初始值返回 null
 * （停留在列表态，由调用方提示「已被清理」）。纯函数：BrowserLiveReplay 的自动打开与
 * watch 重置竞争问题靠它 + 每行 :key 重新武装解决（方案 §6.4）。
 */
export function matchInitialReplay<T extends { liveId: string }>(
  summaries: T[],
  initialLiveId?: string | null,
): T | null {
  if (!initialLiveId) return null
  return summaries.find((item) => item.liveId === initialLiveId) ?? null
}

// ---------- 展示格式化 ----------

export const REPLAY_BADGE_UNSETTLED = '未正常结束'
export const REPLAY_BADGE_TRUNCATED = '已截断'

/** 时长：null（未结算场）/ 负值 → 「时长未知」；与 BrowserLiveReplay 场内文案一致。 */
export function formatReplayDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '时长未知'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

/** 体积：B / KB / MB（与 BrowserLiveReplay 场内文案一致）。 */
export function formatReplayBytes(bytes: number | undefined): string {
  const value = Number.isFinite(bytes) ? Number(bytes) : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/** LOCAL 会话元数据取不到（已删除 / 请求失败）时的占位标题。 */
export function localSessionTitleFallback(sessionId: number): string {
  return `会话 #${sessionId}（已删除）`
}

/** 行标题：有标题用标题，否则回落「会话 #id（已删除）」。 */
export function replayRowTitle(row: Pick<BrowserReplayListItem, 'sessionId' | 'sessionTitle'>): string {
  return row.sessionTitle ?? localSessionTitleFallback(row.sessionId)
}

// ---------- 批量补齐并发控制 ----------

/**
 * 限并发异步映射（LOCAL 标题/Agent 批量补齐用，并发上限 5）：保持入参顺序，
 * 单个失败不阻塞其余（调用方自行决定失败如何呈现）。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
