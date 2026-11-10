/**
 * LLM 调用场景契约（前后端共用，desktop / admin 同步消费）。
 *
 * 场景枚举的事实源在后端 `backend-ts/src/usage/llm-call-context.ts` 的
 * `LLM_CALL_SCENES`；这里放同一份联合类型，供两端汉化表以
 * `Record<LlmCallScene, string>` 声明——漏项在编译期即失败，
 * 不再依赖运行时才发现的英文枚举。
 *
 * 新增场景时必须同步三处，缺一不可：
 *   1. 本文件加联合成员（类型契约）；
 *   2. 后端 `LLM_CALL_SCENES` 加映射（事实源）；
 *   3. desktop / admin 的汉化表加中文（展示）。
 * 其中 3 由 `Record<LlmCallScene, string>` 强制；2 与 1 的一致性由
 * 后端 `llm-call-context.spec.ts` 的 exhaustiveness 断言守住。
 */
export type LlmCallScene =
  | 'agent'
  | 'compaction'
  | 'session_title'
  | 'git_commit_message'
  | 'feedback_experience_draft'
  | 'danger_assess'
  | 'proxy_approve'
  | 'voice_synthesis'
  | 'feishu_summarize'
  | 'connectivity_test'
  | 'memory_extract'
  | 'unknown';

// ─── 单用户用量（"我的用量" / 管理后台用户用量视图共用，2026-11-10 用户用量方案下沉） ───
//
// 事实源：后端 `backend-ts/src/usage/llm-call.service.ts`（summaryForUser / trendsForUser）。
// 消费端：desktop UsageDrawer（桌面"我的用量"）、admin UserUsageTab（用户详情抽屉"用量"页）。
// 口径：连通性自检行（scene=connectivity_test）user_id 恒为 NULL，不进任何单用户聚合；
//       成本 = 模型价格填写口径，未配价行 cost 为 NULL 聚合自动忽略。

/** 统计周期：日历周期在前，滚动窗口在后，自定义区间收尾（今日/昨日时趋势图自动按小时分桶）。 */
export type UsageRange =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'lastWeek'
  | 'month'
  | 'lastMonth'
  | 'last7'
  | 'last30'
  | 'custom';

/** 自定义周期（range=custom）的起止日期，闭区间日历日 YYYY-MM-DD，两端都由用户选定。 */
export interface UsageDateRange {
  startDate: string;
  endDate: string;
}

/** 趋势横轴：day 为日历日，hour 为整点（口径同管理后台 admin-analytics）。 */
export type TrendGranularity = 'day' | 'hour';

/** 周期总账（aggregateSummary 单行产物）。 */
export interface LlmCallSummaryRow {
  callCount: number;
  successCount: number;
  failCount: number;
  /** 窗口内取消数（用户点停止，error_message 含取消标记）；不计入 failCount，也不进成功率分母 */
  cancelledCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** 窗口内成本合计（成本单位 = 模型价格填写口径；未配价行 cost_micros 为 NULL，SUM 自动忽略）。 */
  cost: number;
  /** 可解码行的输出 token 合计（吞吐均值的分子；技术方案 2026-10-27-llm-output-speed §5.1）。 */
  decodeTokens: number;
  /** 可解码行的解码耗时合计（ms，= Σ(duration_ms − first_token_ms)；吞吐均值的分母）。 */
  decodeMs: number;
}

/** 按模型汇总行。 */
export interface LlmCallModelAggRow {
  modelId: number | null;
  modelName: string | null;
  callCount: number;
  failCount: number;
  cancelledCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** 按场景汇总行。 */
export interface LlmCallSceneAggRow {
  scene: string;
  callCount: number;
  failCount: number;
  cancelledCount: number;
  totalTokens: number;
}

/** 按 Agent 汇总（agent_id 为 NULL 的调用——压缩/标题等无归属场景——保留为 id=null 一组）。 */
export interface LlmCallAgentAggRow {
  agentId: number | null;
  agentName: string | null;
  callCount: number;
  failCount: number;
  cancelledCount: number;
  totalTokens: number;
  cost: number;
}

/** 趋势分桶行（后端按日历补零，序列连续无缺口）。 */
export interface LlmCallTrendRow {
  /** day 粒度为 YYYY-MM-DD，hour 粒度为 YYYY-MM-DD HH:00 */
  bucket: string;
  callCount: number;
  failCount: number;
  cancelledCount: number;
  /** 入 Token / 其中命中缓存的 Token，供缓存命中率趋势按桶计算 */
  promptTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cost: number;
  /** 桶内可解码行的输出 token 合计（输出速度趋势的分子；无流式调用的桶为 0）。 */
  decodeTokens: number;
  /** 桶内可解码行的解码耗时合计（ms，输出速度趋势的分母；无流式调用的桶为 0）。 */
  decodeMs: number;
}

/** 解析后的统计窗口（Asia/Shanghai 日历日闭区间）：深链调用流水等需要具体日期的场景直接取用。 */
export interface UsageWindow {
  startYmd: string;
  endYmd: string;
}

/** 单用户用量总览：指定周期（缺省由后端回落 last30）总账 + 按模型 + 按场景 + 按 Agent，一次请求给全。 */
export interface MyUsageSummary {
  range: UsageRange;
  window: UsageWindow;
  totals: LlmCallSummaryRow;
  byModel: LlmCallModelAggRow[];
  byScene: LlmCallSceneAggRow[];
  byAgent: LlmCallAgentAggRow[];
}

/** 单用户用量趋势：按天/小时分桶的连续序列（后端补零，无缺口）。 */
export interface MyUsageTrends {
  range: UsageRange;
  granularity: TrendGranularity;
  window: UsageWindow;
  buckets: LlmCallTrendRow[];
}
