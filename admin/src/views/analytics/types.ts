export type AnalyticsScope = 'overview' | 'trends' | 'models' | 'users' | 'agents' | 'sessions'

export type PeriodValue = number | 'today' | 'yesterday'

export interface AnalyticsPeriod {
  days: number
  endOffset: number
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
  activeUsers: number
  completedSessions: number
  failedSessions: number
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
  callTokens?: number
  promptTokens?: number
  cachedTokens?: number
  callSuccessRate?: number | null
  cacheHitRate?: number | null
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
  trends: TrendPoint[]
  periodTotals: PeriodTotals & {
    callCount?: number
    callFailCount?: number
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
  retryCallCount: number
  promptTokens: number
  cachedTokens: number
  callTokens: number
  successRate?: number | null
  retryRatio?: number | null
  cacheHitRate?: number | null
  firstTokenP50?: number | null
  firstTokenP95?: number | null
  durationP50?: number | null
  durationP95?: number | null
}

export interface NamedCallStat {
  key: string
  callCount: number
  failCount: number
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
  callSuccessRate?: number | null
  callTokens?: number
  promptTokens?: number
  cachedTokens?: number
  cacheHitRate?: number | null
  avgFirstTokenMs?: number | null
  avgDurationMs?: number | null
  retryCallCount?: number
}

export interface ModelsPayload {
  period: AnalyticsPeriodMeta
  modelStats: ModelStatRow[]
  periodTotals: { totalTokens: number }
  previousTotals: PreviousTotals
  sceneStats?: NamedCallStat[]
  protocolStats?: NamedCallStat[]
  sceneModelId?: number | null
  excludeConnectivity?: boolean
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
  callTokens?: number
}

export interface UsersPayload {
  period: AnalyticsPeriodMeta
  userActivity: UserActivityRow[]
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
  callTokens?: number
  callSuccessRate?: number | null
}

export interface AgentsPayload {
  period: AnalyticsPeriodMeta
  agentStats: AgentStatRow[]
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
  days: number
  endOffset: number
  limit?: number
  modelId?: number
  excludeConnectivity?: boolean
}
