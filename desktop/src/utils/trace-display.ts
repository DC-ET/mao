/** 运行轨迹展示层纯函数：结果状态、关注点徽标、会话汇总与格式化。
 *  供 RunTracePanel 与单测共用；语义与后端 VO（session-vo.ts 的 RunTraceVO）对齐。 */
import type { RunTrace } from '../types/trace'

/** run 结果状态：失败优先于中断，其余算成功。重试 / 慢 / 贵只是关注点，不改变结果状态。 */
export type RunStatus = 'ok' | 'interrupted' | 'error'

export const RUN_STATUS_META: Record<RunStatus, { label: string }> = {
  ok: { label: '成功' },
  interrupted: { label: '中断' },
  error: { label: '失败' },
}

export function runStatus(run: RunTrace): RunStatus {
  const rounds = run.segments.flatMap((s) => s.rounds)
  if (rounds.some((r) => !r.success && !r.interrupted)) return 'error'
  if (rounds.some((r) => r.interrupted)) return 'interrupted'
  return 'ok'
}

export interface RunBadge { label: string; tone: 'neutral' | 'warn' | 'info' }

/** 摘要行的关注点徽标。结果状态已由状态图标表达，这里只留过程与阈值类；
 *  默认收拢成 +N，点开展开——徽标全铺会把用户消息挤出摘要行。 */
export function runAttentionBadges(run: RunTrace): RunBadge[] {
  const rounds = run.segments.flatMap((s) => s.rounds)
  const badges: RunBadge[] = []
  if (rounds.some((r) => r.retryCount > 0)) badges.push({ label: '重试', tone: 'warn' })
  if (rounds.some((r) => r.slow)) badges.push({ label: '慢', tone: 'info' })
  if (rounds.some((r) => r.expensive)) badges.push({ label: '贵', tone: 'info' })
  if (run.markers.length > 0) badges.push({ label: '压缩', tone: 'neutral' })
  if (run.segments.some((s) => s.kind === 'before_edit')) badges.push({ label: '编辑前', tone: 'neutral' })
  return badges
}

export interface RunTraceSummary {
  runCount: number
  ok: number
  error: number
  interrupted: number
  wallClockMs: number
  tokens: number
  /** 与后端同口径：窗口内任一行未配价则合计为 null，不把配价 run 的和冒充总成本 */
  costMicros: number | null
  toolSuccess: number
  toolError: number
}

/** 对当前已加载的 run 做会话级汇总：轨迹是「汇总 → 下钻」型数据，先回答「整体怎么样」。 */
export function summarizeRuns(runs: RunTrace[]): RunTraceSummary {
  const summary: RunTraceSummary = {
    runCount: runs.length,
    ok: 0,
    error: 0,
    interrupted: 0,
    wallClockMs: 0,
    tokens: 0,
    costMicros: null,
    toolSuccess: 0,
    toolError: 0,
  }
  let anyUnpriced = false
  for (const run of runs) {
    summary[runStatus(run)] += 1
    summary.wallClockMs += run.totals.wallClockMs
    summary.tokens +=
      run.totals.promptTokens + run.totals.completionTokens + run.totals.cachedTokens + run.totals.cacheCreationTokens
    summary.toolSuccess += run.totals.toolSuccess
    summary.toolError += run.totals.toolError
    if (run.totals.costMicros == null) anyUnpriced = true
    else summary.costMicros = (summary.costMicros ?? 0) + run.totals.costMicros
  }
  if (anyUnpriced) summary.costMicros = null
  return summary
}

/** 工具成功率：没有工具调用时返回 null（不显示 0% 误导）。 */
export function toolSuccessRate(summary: RunTraceSummary): number | null {
  const total = summary.toolSuccess + summary.toolError
  if (total <= 0) return null
  return Math.round((summary.toolSuccess / total) * 100)
}

/** "yyyy-MM-dd HH:mm:ss" → "HH:mm"；缺时间戳返回空串。 */
export function formatClock(startedAt: string | null): string {
  if (startedAt == null) return ''
  const matched = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(startedAt)
  return matched ? matched[1]! : startedAt
}

/** token 折算：>=1M 用 M，>=1 万用 k，其余千分位——20.40M 比 20392.7k 好读。K/M 前固定两位小数。 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(2)}k`
  return tokens.toLocaleString('zh-CN')
}
