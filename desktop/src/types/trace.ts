/** run 轨迹 VO（与后端 session-vo.ts 的 RunTracePageVO 对齐） */
export interface RunTracePage {
  runs: RunTrace[]
  hasMore: boolean
  /** 仅第一页；没有则 null。会话级「未归属」 */
  unattributed: UnattributedGroup | null
}

export interface UnattributedGroup {
  count: number
  startedAt: string | null
  endedAt: string | null
  rounds: TraceRound[]
  tools: TraceTool[]
}

export interface RunTrace {
  runId: number
  userMessagePreview: string
  startedAt: string | null
  segments: TraceSegment[]
  sideCalls: TraceSideCall[]
  subagentLinks: Array<{ sessionId: number; title: string | null }>
  markers: TraceMarker[]
  totals: {
    wallClockMs: number
    costMicros: number | null
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    cacheCreationTokens: number
    toolSuccess: number
    toolError: number
  }
}

export interface TraceSegment {
  kind: 'before_edit' | 'current'
  rounds: TraceRound[]
  unplacedTools: TraceTool[]
}

export interface TraceRound {
  seq: number
  modelName: string | null
  scene: string
  /** llm_call.created_at：调用结束时刻，导出 CSV 的「时间」列 */
  createdAt: string | null
  durationMs: number
  firstTokenMs: number | null
  retryCount: number
  success: boolean
  interrupted: boolean
  errorMessage: string | null
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  costMicros: number | null
  slow: boolean
  expensive: boolean
  tools: TraceTool[]
}

export interface TraceSideCall {
  scene: string
  modelName: string | null
  /** llm_call.created_at：调用结束时刻，导出 CSV 的「时间」列 */
  createdAt: string | null
  durationMs: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  costMicros: number | null
  success: boolean
}

export interface TraceTool {
  toolCallId: string | null
  name: string
  target: string | null
  status: string
  /** 历史行与未回填行为 null，UI 显示「—」 */
  durationMs: number | null
  approvalMark: string | null
  /** 用户手动文件操作才是 user；历史行与工具活动缺省 */
  actor?: 'user' | 'agent' | null
}

export interface TraceMarker {
  kind: 'compaction'
  atMessageId: number
  detail: string
}

/** 慢 / 贵阈值：展示参数，桌面记 localStorage（不新建偏好表） */
export interface TraceThresholds {
  slowMs: number
  expensiveTokens: number
}

export const DEFAULT_TRACE_THRESHOLDS: TraceThresholds = { slowMs: 60_000, expensiveTokens: 50_000 }

/** 进行中临时态按 executionId 隔离：崩溃恢复 / 重跑换 executionId，旧帧不画进当前 run */
export interface TraceLiveRound {
  round: number
  inModelCall: boolean
}

export interface TraceLiveTool {
  toolCallId: string
  name: string
  startedAt: number
}
