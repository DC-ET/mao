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
  /** llm_call 主键：轮次行下钻的定位 key；历史行理论上恒有值 */
  llmCallId: number | null
  /**
   * 估算开始时刻（epoch ms）= Date.parse(created_at) − duration_ms；
   * 两侧任一缺失为 null（时间条带不画色条、tooltip 显示「—」）。不补 0、不冒充。
   */
  startedAtMs: number | null
  /** llm_call.provider 冗余快照列；null 时不渲染徽标 */
  provider: string | null
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
  /** 估算开始时刻（epoch ms）；口径与 TraceRound.startedAtMs 一致 */
  startedAtMs: number | null
  /** llm_call.provider 冗余快照列；null 时不渲染徽标 */
  provider: string | null
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
  /** 估算开始时刻（epoch ms）；两侧任一缺失为 null（时间条带不画色条） */
  startedAtMs: number | null
  approvalMark: string | null
  /** 用户手动文件操作才是 user；历史行与工具活动缺省 */
  actor?: 'user' | 'agent' | null
}

export interface TraceMarker {
  kind: 'compaction'
  atMessageId: number
  detail: string
}

/**
 * 慢 / 贵阈值：展示参数，桌面记 localStorage（不新建偏好表）。
 * 「贵」按单轮成本（价格填写口径的金额，单位元）判定；模型未配置价格的轮次不算贵。
 */
export interface TraceThresholds {
  slowMs: number
  expensiveCost: number
}

export const DEFAULT_TRACE_THRESHOLDS: TraceThresholds = { slowMs: 60_000, expensiveCost: 0.5 }

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

/* ------------------------------------------------------------------ *
 * 记录详情（与后端 session-vo.ts 的 TraceToolRecordVO / TraceCallRecordVO 对齐）
 * 轨迹主 VO 不带正文，按需拉取；配不上的字段为 null，前端提示而非静默。
 * ------------------------------------------------------------------ */

/** 配对 llm_call 的完整元信息（配不上为 null）。 */
export interface TraceCallMeta {
  llmCallId: number | null
  provider: string | null
  protocol: string | null
  stream: boolean | null
  effort: string | null
  scene: string | null
  modelName: string | null
  retryCount: number
  firstTokenMs: number | null
  durationMs: number
  errorMessage: string | null
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  costMicros: number | null
  createdAt: string | null
  /** 请求构成采集（V172）：系统提示词原文（截断带标记）；null = 未记录（历史行 / 无 system 消息） */
  systemPrompt: string | null
  /** 请求的工具名清单（JSON 字符串数组）；null = 未记录（历史行 / 无工具） */
  toolsJson: string | null
}

/** 工具记录详情：参数 / 结果原文 + 配对的调用元信息。 */
export interface TraceToolRecord {
  toolCallId: string
  toolName: string | null
  argumentsJson: string | null
  resultContent: string | null
  resultMetadata: string | null
  call: TraceCallMeta | null
}

/** 轮次记录详情里的单条助手消息（通常一条；崩溃恢复 / 时钟缺失为零条）。 */
export interface TraceRoundMessage {
  messageId: number
  content: string | null
  thinkingContent: string | null
  tokenCount: number | null
  createdAt: string | null
}

/** 轮次记录详情：调用元信息 + 本轮工具清单（供抽屉内跳转）+ 本轮回复快照。 */
export interface TraceCallRecord {
  call: TraceCallMeta | null
  tools: Array<{ toolCallId: string; name: string; target: string | null }>
  messages: TraceRoundMessage[]
}

/** 单条消息详情（用户消息抽屉）：主键直查，无窗口推导。 */
export interface TraceMessageRecord {
  messageId: number
  role: string | null
  /** 原文；多模态数组时为 JSON 分片数组原样，前端合并文本分片 + 附件计数 */
  content: string | null
  thinkingContent: string | null
  tokenCount: number | null
  createdAt: string | null
  updatedAt: string | null
  /** 编辑重发的更新时刻；与 createdAt 相同视为未编辑 */
  edited: boolean
}

/**
 * 记录详情抽屉的打开目标：工具抽屉按 toolCallId，轮次抽屉按 llmCallId，
 * 消息抽屉按 messageId（= run 锚点 id）。
 * 三者 key 语义不同（两个查 message 表、一个查 llm_call 表），后端按端点分流。
 */
export type TraceDrawerTarget =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'call'; llmCallId: number }
  | { kind: 'message'; messageId: number }

/** 抽屉里已加载的记录：带 kind 判别（与 store 缓存同型，缓存命中后直接渲染）。 */
export type TraceLoadedRecord =
  | { kind: 'tool'; data: TraceToolRecord }
  | { kind: 'call'; data: TraceCallRecord }
  | { kind: 'message'; data: TraceMessageRecord }
