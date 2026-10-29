export type AnalyticsScope =
  | 'overview'
  | 'trends'
  | 'models'
  | 'users'
  | 'agents'
  | 'sessions'
  | 'run-trace'

/** 运行轨迹榜单的排行维度：按 Agent 或按用户 */
export type RunTraceDimension = 'agent' | 'user'

export interface RunTraceRoundRow {
  scopeKey: number
  scopeName: string
  sessionId: number | null
  modelName: string | null
  createdAt: string | null
  durationMs: number
  totalTokens: number
  costMicros: number | null
  /** 该维度在窗口内的调用总数，供标注样本量 */
  callCount: number
}

export interface RunTraceToolFailureRow {
  toolType: string
  errorCount: number
  totalCount: number
  /** 失败率（%），保留一位小数 */
  failRate: number
}

export interface RunTracePayload {
  period: AnalyticsPeriodMeta
  /** 榜单口径的 llm_call scene，默认 agent */
  scene: string
  scope: RunTraceDimension
  slowestRounds: RunTraceRoundRow[]
  mostExpensiveRounds: RunTraceRoundRow[]
  toolFailureRates: RunTraceToolFailureRow[]
}

/**
 * 统计周期：滚动天数（3 / 7 / 30 / 90）、今日 / 昨日、日历周期（本周 / 上周 / 本月 / 上月）、
 * 以及自定义区间（custom，起止日见 CustomPeriodRange）。
 */
export type PeriodValue =
  | number
  | 'today'
  | 'yesterday'
  | 'week'
  | 'lastWeek'
  | 'month'
  | 'lastMonth'
  | 'custom'

/** 自定义统计周期：闭区间日历日（YYYY-MM-DD），时区口径与后端一致（Asia/Shanghai）。 */
export interface CustomPeriodRange {
  start: string
  end: string
}

export interface AnalyticsPeriodMeta {
  days: number
  start: string
  end: string
  previousStart: string
  previousEnd: string
}

export interface PeriodTotals {
  sessions: number
  messages: number
  chatTokens: number
  backgroundTokens: number
  totalTokens: number
  backgroundCalls: number
  /** 窗口成本合计（成本单位 = 模型价格填写口径；唯一口径 llm_call） */
  totalCost: number
  activeUsers: number
  completedSessions: number
  failedSessions: number
  /** 窗口 llm_call 入 Token 合计（缓存命中率的分母，默认排除连通性自检） */
  promptTokens?: number
  /** 窗口 llm_call 命中缓存的 Token 合计（缓存命中率的分子） */
  cachedTokens?: number
  /** 缓存命中率（%）= cachedTokens / promptTokens；无调用（分母为 0）时为 null */
  cacheHitRate?: number | null
}

export type PreviousTotals = Partial<PeriodTotals>

export interface TrendPoint {
  date: string
  sessions: number
  messages: number
  chatTokens: number
  backgroundTokens: number
  totalTokens: number
  backgroundCalls: number
  callCount?: number
  callFailCount?: number
  /** 当日取消数（用户点停止）：不计入 callFailCount，也不进成功率分母 */
  callCancelledCount?: number
  callTokens?: number
  promptTokens?: number
  cachedTokens?: number
  /** 当日 llm_call 成本（成本单位） */
  cost?: number
  callSuccessRate?: number | null
  cacheHitRate?: number | null
  /** 桶内平均总耗时（ms）= Σduration_ms ÷ 调用数；无调用为 null */
  avgDurationMs?: number | null
  /** 桶内平均首字耗时（ms）= Σfirst_token_ms ÷ 流式调用数；无流式调用为 null */
  avgFirstTokenMs?: number | null
  /** 桶内每百万 Token 平均成本 = cost ÷ callTokens × 1e6；无调用为 null */
  costPerMTokens?: number | null
}

export interface SparkPoint {
  date: string
  totalTokens: number
}

export interface PhaseRow {
  phase: string
  count: number
}

export interface Insight {
  level: 'info' | 'warn'
  text: string
  path?: string
}

export interface OverviewPayload {
  period: AnalyticsPeriodMeta
  overview: Record<string, number | string>
  periodTotals: PeriodTotals
  previousTotals: PreviousTotals
  spark: SparkPoint[]
  phaseDistribution: PhaseRow[]
  insights: Insight[]
}

export interface TrendsPayload {
  period: AnalyticsPeriodMeta
  granularity?: 'hour' | 'day'
  trends: TrendPoint[]
  periodTotals: PeriodTotals & {
    callCount?: number
    callFailCount?: number
    callCancelledCount?: number
    callTokens?: number
    promptTokens?: number
    cachedTokens?: number
  }
  previousTotals: PreviousTotals
  callQuality?: CallQualitySummary
}

export interface CallQualitySummary {
  callCount: number
  successCount: number
  failCount: number
  /** 取消数（用户点停止）：不计入失败，成功率分母 = callCount − cancelledCount */
  cancelledCount: number
  retryCallCount: number
  promptTokens: number
  cachedTokens: number
  callTokens: number
  /** 窗口成本合计（成本单位，llm_call 口径） */
  cost: number
  successRate?: number | null
  retryRatio?: number | null
  cacheHitRate?: number | null
  firstTokenP50?: number | null
  firstTokenP95?: number | null
  durationP50?: number | null
  durationP95?: number | null
  /** 吞吐 p50 / p95（tok/s，输出 tokens ÷ 解码耗时）；无可解码行（全非流式）时为 null */
  throughputP50?: number | null
  throughputP95?: number | null
}

export interface NamedCallStat {
  key: string
  callCount: number
  failCount: number
  cancelledCount: number
  callTokens: number
}

export interface FailTopItem {
  key: string | number
  name: string
  failCount: number
  callCount: number
}

export interface ModelStatRow {
  modelId: number
  modelName: string
  provider?: string
  status?: number
  isDefault?: number
  sessionCount: number
  messageCount: number
  chatTokens: number
  backgroundTokens: number
  totalTokens: number
  backgroundCalls: number
  contextWindowTokens?: number
  callCount?: number
  callFailCount?: number
  /** 取消数（用户点停止）：不计入失败，不进成功率分母 */
  callCancelledCount?: number
  callSuccessRate?: number | null
  callTokens?: number
  promptTokens?: number
  cachedTokens?: number
  /** 窗口内成本合计（成本单位，llm_call 口径） */
  cost?: number
  cacheHitRate?: number | null
  avgFirstTokenMs?: number | null
  avgDurationMs?: number | null
  /** 窗口吞吐均值（tok/s，加权平均 = Σ输出 ÷ Σ解码秒）；无可解码行时为 null */
  avgThroughput?: number | null
  retryCallCount?: number
}

export interface ModelsPayload {
  period: AnalyticsPeriodMeta
  modelStats: ModelStatRow[]
  periodTotals: { totalTokens: number; totalCost: number }
  previousTotals: PreviousTotals
  sceneStats?: NamedCallStat[]
  protocolStats?: NamedCallStat[]
  sceneModelId?: number | null
  excludeConnectivity?: boolean
  /** 窗口内按 Token 排序截断的用户分布（与用户 Tab tokenTop 同源），供模型页并排环图 */
  userTokenTop?: Array<{ userId: number; username?: string; displayName?: string; totalTokens: number }>
}

export interface UserActivityRow {
  userId: number
  username: string
  displayName?: string
  sessionCount: number
  messageCount: number
  totalTokens: number
  lastLoginAt?: string | null
  callCount?: number
  callFailCount?: number
  callCancelledCount?: number
  callTokens?: number
  /** 窗口内成本合计（成本单位，llm_call 口径） */
  cost?: number
}

export interface UsersPayload {
  period: AnalyticsPeriodMeta
  userActivity: UserActivityRow[]
  /** 独立按 Token 排序截断的排行（与按消息数截断的 userActivity 互不影响） */
  tokenTop?: Array<{ userId: number; username?: string; displayName?: string; totalTokens: number }>
  periodTotals: { activeUsers: number }
  previousTotals: PreviousTotals
}

export interface AgentStatRow {
  agentId: number
  agentName: string
  sessionCount: number
  messageCount: number
  totalTokens: number
  callCount?: number
  callFailCount?: number
  callCancelledCount?: number
  callTokens?: number
  /** 窗口内成本合计（成本单位，llm_call 口径） */
  cost?: number
  callSuccessRate?: number | null
}

export interface AgentsPayload {
  period: AnalyticsPeriodMeta
  agentStats: AgentStatRow[]
  /** 独立按 Token 排序截断的排行（与按会话/消息数截断的 agentStats 互不影响） */
  tokenTop?: Array<{ agentId: number; agentName: string; totalTokens: number }>
  previousTotals: PreviousTotals
}

export interface NamedCount {
  count: number
}

export interface SessionsPayload {
  period: AnalyticsPeriodMeta
  phaseDistribution: PhaseRow[]
  sessionTypes: Array<NamedCount & { sessionType: string }>
  executionModes: Array<NamedCount & { executionMode: string }>
  livePhases: PhaseRow[]
  periodTotals: {
    sessions: number
    activeUsers: number
    completedSessions: number
    failedSessions: number
  }
  previousTotals: PreviousTotals
  callQuality?: CallQualitySummary
  failTop?: {
    byModel: FailTopItem[]
    byScene: FailTopItem[]
  }
  excludeConnectivity?: boolean
}

export interface AnalyticsQuery {
  /** 语义统计周期：后端据此解析窗口（见 backend-ts/src/admin/analytics-range.ts） */
  range: PeriodValue
  /** 自定义区间起止日，仅 range=custom 时下发 */
  start?: string
  end?: string
  limit?: number
  modelId?: number
  excludeConnectivity?: boolean
  granularity?: 'hour' | 'day'
  /** 运行轨迹榜单的 llm_call scene 口径 */
  scene?: string
  /** 运行轨迹榜单的排行维度（与后端 /admin/analytics/run-trace 的 scope 参数同名） */
  scope?: RunTraceDimension
}
