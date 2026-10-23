/** 运行轨迹展示层纯函数：结果状态、关注点徽标、会话汇总、计时补全与时间条带几何。
 *  供 RunTracePanel 与单测共用；语义与后端 VO（session-vo.ts 的 RunTraceVO）对齐。 */
import type { RunTrace, TraceRound, TraceTool } from '../types/trace'
import { getToolDisplayName } from './toolDisplay'
import { llmCallSceneLabel } from './llmCallLabels'

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
    // promptTokens 是总输入（OpenAI prompt_tokens 含缓存命中，Anthropic 适配器已把
    // cache_read / cache_creation 并入 promptTokens），缓存分项只做展示，不能再加一次。
    summary.tokens += run.totals.promptTokens + run.totals.completionTokens
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

/* ------------------------------------------------------------------ *
 * 计时补全（技术方案 2026-10-22-run-trace-deep-dive §5.7）
 * 解码耗时与吞吐量是纯派生量，不进 VO：同一数字两处真相会让「哪个对」变成问题。
 * 异常行（首字晚于结束、解码为 0）一律 null → 显示「—」，不出负数、不出 Infinity。
 * ------------------------------------------------------------------ */

/** 解码耗时 = durationMs − firstTokenMs；首字缺失或晚于结束（时钟异常）时为 null。 */
export function decodingMs(round: Pick<TraceRound, 'durationMs' | 'firstTokenMs'>): number | null {
  if (round.firstTokenMs == null) return null
  if (round.firstTokenMs > round.durationMs) return null
  return round.durationMs - round.firstTokenMs
}

/** 吞吐量 = 输出 token ÷ 解码秒；解码不可算或为 0、输出为 0 时为 null（不显示 0 误导）。 */
export function throughput(round: Pick<TraceRound, 'durationMs' | 'firstTokenMs' | 'completionTokens'>): number | null {
  const decode = decodingMs(round)
  if (decode == null || decode <= 0) return null
  if (round.completionTokens <= 0) return null
  return round.completionTokens / (decode / 1000)
}

/** 吞吐量展示：1 位小数 + 单位；null → 「—」。 */
export function formatThroughput(round: Pick<TraceRound, 'durationMs' | 'firstTokenMs' | 'completionTokens'>): string {
  const value = throughput(round)
  return value == null ? '—' : `${value.toFixed(1)} tok/s`
}

/* ------------------------------------------------------------------ *
 * 时间概览条带（技术方案 2026-10-22-run-trace-deep-dive §5.5）
 * 横轴取 run 内全部节点估算起止的 min/max，不用 totals.wallClockMs
 * （墙钟是跨度不是右端点，直接当总宽会让最后一条色条溢出右边界）。
 * ------------------------------------------------------------------ */

export interface TimeBandNode {
  /**
   * 定位 key：round 用 `round:${段}:${seq}`，工具用 `tool:${段}:${toolAnchorKey(tool)}`，
   * 旁路用 `side:${index}`。段维度必须有——编辑重发时 before_edit / current 两段
   * 各自从 1 编号，只用 seq 会撞 key 与行锚点；旁路调用不在任何段内，用 index 即可。
   * 工具侧用 `toolCallId|target|name` 三元组（与面板行 :key 同口径）：用户手动文件写入
   * / Git 操作这类未挂轮活动没有 tool_call_id，只用 name 会让同一 run 内两条同类活动
   * 产生完全相同的 key（v-for 重复 key + 行锚点 id 重复 + 定位指到第一条行）。
   */
  key: string
  kind: 'round' | 'tool' | 'side'
  label: string
  startedAtMs: number | null
  durationMs: number | null
  firstTokenMs: number | null
  status: 'ok' | 'error' | 'interrupted'
  /** 工具节点对应的原始行对象：面板据此把行锚点 id 与条带 key 对齐；轮次 / 旁路为 undefined */
  toolRef?: TraceTool
}

/** run 内可投影的节点：轮次（before_edit 与 current 都取）、工具（含未挂到轮）、旁路调用。
 *  startedAtMs / durationMs 缺失的节点仍进数组（tooltip 说明与总数），但不画色条。
 *  key 与行锚点 id 必须一一对应且唯一：编辑重发时 before_edit / current 两段各自从 1
 *  编号，只用 seq 会撞 key（v-for 重复 key + getElementById 取到编辑前那一行），
 *  所以 round / tool 的 key 都带段维度；side 旁路调用不在任何段内，用 index 即可。
 *  工具 key 复用 toolAnchorKey 口径（toolCallId|target|name），保证条带 key 与行锚点
 *  id 严格同源——两处口径一旦分叉，点击色条就会定位到别的行。 */
export function runTimeNodes(run: RunTrace): TimeBandNode[] {
  const nodes: TimeBandNode[] = [];
  let toolOrdinal = 0;
  for (const segment of run.segments) {
    for (const round of segment.rounds) {
      nodes.push({
        key: `round:${segment.kind}:${round.seq}`,
        kind: 'round',
        label: `#${round.seq} ${round.modelName ?? '未知模型'}`,
        startedAtMs: round.startedAtMs,
        durationMs: round.durationMs,
        firstTokenMs: round.firstTokenMs,
        status: round.interrupted ? 'interrupted' : (round.success ? 'ok' : 'error'),
      });
    }
    for (const tool of segment.unplacedTools) {
      nodes.push(toolNode(tool, segment.kind, toolOrdinal++));
    }
    for (const round of segment.rounds) {
      for (const tool of round.tools) {
        nodes.push(toolNode(tool, segment.kind, toolOrdinal++));
      }
    }
  }
  run.sideCalls.forEach((side, index) => {
    nodes.push({
      key: `side:${index}`,
      kind: 'side',
      label: `${llmCallSceneLabel(side.scene)} · ${side.modelName ?? '未知模型'}`,
      startedAtMs: side.startedAtMs,
      durationMs: side.durationMs,
      firstTokenMs: null,
      status: side.success ? 'ok' : 'error',
    });
  });
  return nodes;
}

/**
 * 工具在条带 key / 行锚点里的统一标识：`${toolCallId ?? ''}|${target ?? ''}|${name}`。
 * 与 RunTracePanel.vue 的 toolKey() 逐字节同口径（该函数是行渲染 :key 的实现）。
 * 只用 `toolCallId ?? name` 不够：用户手动文件写入 / Git 操作这类未挂轮活动
 * （workspace-write.service.ts、git-write-operation.service.ts）detailJson 里没有
 * tool_call_id，name 又取 activity.summary——同一 run 内两条同类活动的 key 会完全相同，
 * 造成 v-for 重复 key、行锚点 id 重复、getElementById 定位指到第一条行。
 * 调用方（行锚点与条带节点）各自追加段内序号，三元组仍相同时也保证唯一。
 */
export function toolAnchorKey(tool: TraceTool): string {
  return `${tool.toolCallId ?? ''}|${tool.target ?? ''}|${tool.name}`
}

function toolNode(tool: TraceTool, segmentKind: string, ordinal: number): TimeBandNode {
  return {
    key: `tool:${segmentKind}:${toolAnchorKey(tool)}|${ordinal}`,
    kind: 'tool',
    // 带段后缀：同一工具在编辑前 / 当前两段都被调用时，两条 tooltip 也能分辨
    label: `${toolDisplayNameForBand(tool.name)}（${segmentKind === 'before_edit' ? '编辑前' : '当前'}）`,
    startedAtMs: tool.startedAtMs,
    durationMs: tool.durationMs,
    firstTokenMs: null,
    status: tool.status === 'ERROR' ? 'error' : 'ok',
    toolRef: tool,
  };
}

/** 条带 tooltip 用的工具名：优先中文展示名，退回原名（与面板工具行一致）。 */
function toolDisplayNameForBand(name: string): string {
  try {
    return getToolDisplayName(name) || name;
  } catch {
    return name;
  }
}

/** 全部节点估算起止的 min/max；全 null 返回 null（组件整体不渲染，不画空条）。 */
export function runTimeWindow(nodes: TimeBandNode[]): { startMs: number; endMs: number } | null {
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const node of nodes) {
    if (node.startedAtMs == null || node.durationMs == null) continue;
    const end = node.startedAtMs + Math.max(0, node.durationMs);
    if (startMs == null || node.startedAtMs < startMs) startMs = node.startedAtMs;
    if (endMs == null || end > endMs) endMs = end;
  }
  if (startMs == null || endMs == null) return null;
  return { startMs, endMs };
}

export interface TimeBandSegment {
  x: number
  width: number
  part: 'ttft' | 'decode'
}

/**
 * 单个色条在给定横轴上的几何（百分比坐标）。起止不可估算返回 null → 不画。
 * 助手轮次分「首字 / 解码」两段：firstTokenMs 有效且落在 (0, durationMs) 内才分段，
 * 两段宽度和恒等于总宽；否则单段（firstTokenMs 为 null 的非流式调用退化为单段）。
 * lane 由调用方（TIME_BAND_LANES）映射后用于 y 坐标，这里只算 x 与宽——
 * 几何与泳道解耦，单测不必关心泳道序号。
 */
export function timeBandGeometry(
  node: TimeBandNode,
  window: { startMs: number; endMs: number },
  width: number,
): { x: number; width: number; segments: TimeBandSegment[] | null } | null {
  if (node.startedAtMs == null || node.durationMs == null) return null;
  const span = window.endMs - window.startMs;
  const duration = Math.max(0, node.durationMs);
  // 单点窗口（startMs === endMs）给最小宽度，避免除零
  const effectiveSpan = span > 0 ? span : 1;
  const x = ((node.startedAtMs - window.startMs) / effectiveSpan) * width;
  const total = Math.max((duration / effectiveSpan) * width, 0.5);
  const segments = node.firstTokenMs != null && node.firstTokenMs > 0 && node.firstTokenMs < duration
    ? [
      { x, width: (node.firstTokenMs / duration) * total, part: 'ttft' as const },
      { x: x + (node.firstTokenMs / duration) * total, width: total - (node.firstTokenMs / duration) * total, part: 'decode' as const },
    ]
    : null;
  return { x, width: total, segments };
}

/** 泳道序号：轮次 / 工具 / 旁路各一条（同一泳道内并行色条自然重叠，不做堆叠避让）。 */
export const TIME_BAND_LANES: Record<TimeBandNode['kind'], number> = { round: 0, tool: 1, side: 2 }
