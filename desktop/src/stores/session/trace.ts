import { ref, watch } from 'vue'
import type {
  RunTrace,
  TraceLiveRound,
  TraceLiveTool,
  TraceThresholds,
  UnattributedGroup
} from '../../types/trace'
import { DEFAULT_TRACE_THRESHOLDS } from '../../types/trace'
import { safeSetItem } from '../../utils/safe-storage'

const THRESHOLDS_KEY = 'mao:trace-thresholds'

function loadThresholds(): TraceThresholds {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY)
    if (!raw) return { ...DEFAULT_TRACE_THRESHOLDS }
    const parsed = JSON.parse(raw) as Partial<TraceThresholds>
    return {
      slowMs: typeof parsed.slowMs === 'number' && parsed.slowMs > 0 ? parsed.slowMs : DEFAULT_TRACE_THRESHOLDS.slowMs,
      expensiveTokens: typeof parsed.expensiveTokens === 'number' && parsed.expensiveTokens > 0
        ? parsed.expensiveTokens
        : DEFAULT_TRACE_THRESHOLDS.expensiveTokens
    }
  } catch {
    return { ...DEFAULT_TRACE_THRESHOLDS }
  }
}

/**
 * run 轨迹状态：REST 完成态快照 + 进行中临时态。
 * 临时态按 `${sessionId}|${executionId}` 隔离——崩溃恢复 / 重跑会换 executionId，
 * 陈旧执行的 round_* / tool_call_* 帧不得画进当前 run（WS 侧已有陈旧过滤兜底）。
 */
export function createTraceModule() {
  const traceRuns = ref<Map<string, RunTrace[]>>(new Map())
  const traceHasMore = ref<Map<string, boolean>>(new Map())
  const traceUnattributed = ref<Map<string, UnattributedGroup | null>>(new Map())
  const traceLoading = ref<Map<string, boolean>>(new Map())
  /** 慢 / 贵阈值：localStorage 持久化，改完带 query 重拉 */
  const traceThresholds = ref<TraceThresholds>(loadThresholds())
  /** 本次执行的轮次临时行（round_start / round_end 驱动） */
  const liveRounds = ref<Map<string, TraceLiveRound>>(new Map())
  /** 进行中工具计时（tool_call_start 起表，结果回来或执行结束清除） */
  const liveTools = ref<Map<string, TraceLiveTool[]>>(new Map())

  watch(traceThresholds, (value) => {
    safeSetItem(THRESHOLDS_KEY, JSON.stringify(value))
  }, { deep: true })

  function getTraceRuns(sessionId: string): RunTrace[] {
    return traceRuns.value.get(String(sessionId)) ?? []
  }

  function getTraceHasMore(sessionId: string): boolean {
    return traceHasMore.value.get(String(sessionId)) ?? false
  }

  function getTraceUnattributed(sessionId: string): UnattributedGroup | null {
    return traceUnattributed.value.get(String(sessionId)) ?? null
  }

  function isTraceLoading(sessionId: string): boolean {
    return traceLoading.value.get(String(sessionId)) ?? false
  }

  /** 首页整页替换（首次打开 / 阈值变更 / 执行结束后重拉） */
  function setTracePage(sessionId: string, page: { runs: RunTrace[]; hasMore: boolean; unattributed: UnattributedGroup | null }) {
    const sid = String(sessionId)
    traceRuns.value.set(sid, page.runs)
    traceHasMore.value.set(sid, page.hasMore)
    traceUnattributed.value.set(sid, page.unattributed)
    traceRuns.value = new Map(traceRuns.value)
    traceHasMore.value = new Map(traceHasMore.value)
    traceUnattributed.value = new Map(traceUnattributed.value)
  }

  /** 翻页追加：unattributed 只在第一页，追加时保持原值 */
  function appendTracePage(sessionId: string, page: { runs: RunTrace[]; hasMore: boolean }) {
    const sid = String(sessionId)
    traceRuns.value.set(sid, [...getTraceRuns(sid), ...page.runs])
    traceHasMore.value.set(sid, page.hasMore)
    traceRuns.value = new Map(traceRuns.value)
    traceHasMore.value = new Map(traceHasMore.value)
  }

  function setTraceLoading(sessionId: string, loading: boolean) {
    traceLoading.value.set(String(sessionId), loading)
    traceLoading.value = new Map(traceLoading.value)
  }

  function setTraceThresholds(thresholds: TraceThresholds) {
    traceThresholds.value = { ...thresholds }
  }

  function clearTrace(sessionId: string) {
    const sid = String(sessionId)
    traceRuns.value.delete(sid)
    traceHasMore.value.delete(sid)
    traceUnattributed.value.delete(sid)
    traceLoading.value.delete(sid)
    traceRuns.value = new Map(traceRuns.value)
    traceHasMore.value = new Map(traceHasMore.value)
    traceUnattributed.value = new Map(traceUnattributed.value)
    traceLoading.value = new Map(traceLoading.value)
  }

  function liveKey(sessionId: string, executionId: string): string {
    return `${sessionId}|${executionId}`
  }

  function getLiveRound(sessionId: string, executionId: string): TraceLiveRound | null {
    return liveRounds.value.get(liveKey(sessionId, executionId)) ?? null
  }

  function getLiveTools(sessionId: string, executionId: string): TraceLiveTool[] {
    return liveTools.value.get(liveKey(sessionId, executionId)) ?? []
  }

  /**
   * 会话当前进行中的 executionId：崩溃恢复 / 重跑会换 executionId，
   * 面板据此只取本次执行的临时行，陈旧帧不画进当前 run。
   * 同一会话同时只有一个执行在跑，取任一临时键即可。
   */
  function getLiveExecutionId(sessionId: string): string | null {
    const prefix = `${String(sessionId)}|`
    for (const key of liveRounds.value.keys()) {
      if (key.startsWith(prefix)) return key.slice(prefix.length)
    }
    for (const key of liveTools.value.keys()) {
      if (key.startsWith(prefix)) return key.slice(prefix.length)
    }
    return null
  }

  function setLiveRound(sessionId: string, executionId: string, round: TraceLiveRound | null) {
    const key = liveKey(sessionId, executionId)
    if (round == null) liveRounds.value.delete(key)
    else liveRounds.value.set(key, round)
    liveRounds.value = new Map(liveRounds.value)
  }

  /** round_start：进入新轮（仍在模型调用中）；round_end：本轮模型调用结束 */
  function applyLiveRoundStart(sessionId: string, executionId: string, round: number) {
    setLiveRound(sessionId, executionId, { round, inModelCall: true })
  }

  function applyLiveRoundEnd(sessionId: string, executionId: string, round: number) {
    const current = getLiveRound(sessionId, executionId)
    if (current != null && current.round === round) {
      setLiveRound(sessionId, executionId, { round, inModelCall: false })
    }
  }

  function applyLiveToolStart(sessionId: string, executionId: string, toolCallId: string, name: string) {
    if (!toolCallId) return
    const key = liveKey(sessionId, executionId)
    const list = [...(liveTools.value.get(key) ?? [])]
    const existing = list.find(t => t.toolCallId === toolCallId)
    if (existing) {
      existing.name = name || existing.name
    } else {
      list.push({ toolCallId, name, startedAt: Date.now() })
    }
    liveTools.value.set(key, list)
    liveTools.value = new Map(liveTools.value)
  }

  function applyLiveToolEnd(sessionId: string, executionId: string, toolCallId: string) {
    const key = liveKey(sessionId, executionId)
    const list = liveTools.value.get(key)
    if (list == null) return
    const next = list.filter(t => t.toolCallId !== toolCallId)
    if (next.length === list.length) return
    if (next.length === 0) liveTools.value.delete(key)
    else liveTools.value.set(key, next)
    liveTools.value = new Map(liveTools.value)
  }

  /** 执行终止（IDLE / COMPLETED / FAILED / CANCELLED）：丢掉临时行，REST 为准 */
  function clearLiveState(sessionId: string, executionId?: string) {
    const sid = String(sessionId)
    if (executionId == null) {
      for (const key of [...liveRounds.value.keys()]) {
        if (key.startsWith(`${sid}|`)) liveRounds.value.delete(key)
      }
      for (const key of [...liveTools.value.keys()]) {
        if (key.startsWith(`${sid}|`)) liveTools.value.delete(key)
      }
    } else {
      liveRounds.value.delete(liveKey(sid, executionId))
      liveTools.value.delete(liveKey(sid, executionId))
    }
    liveRounds.value = new Map(liveRounds.value)
    liveTools.value = new Map(liveTools.value)
  }

  function reset() {
    traceRuns.value = new Map()
    traceHasMore.value = new Map()
    traceUnattributed.value = new Map()
    traceLoading.value = new Map()
    liveRounds.value = new Map()
    liveTools.value = new Map()
  }

  return {
    traceRuns,
    traceHasMore,
    traceUnattributed,
    traceLoading,
    traceThresholds,
    getTraceRuns,
    getTraceHasMore,
    getTraceUnattributed,
    isTraceLoading,
    setTracePage,
    appendTracePage,
    setTraceLoading,
    setTraceThresholds,
    clearTrace,
    getLiveRound,
    getLiveTools,
    getLiveExecutionId,
    applyLiveRoundStart,
    applyLiveRoundEnd,
    applyLiveToolStart,
    applyLiveToolEnd,
    clearLiveState,
    reset,
  }
}
