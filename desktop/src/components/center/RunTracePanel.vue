<template>
  <div class="run-trace-panel">
    <div class="trace-toolbar">
      <div class="trace-toolbar-title">
        <el-icon :size="14"><TrendCharts /></el-icon>
        <span>运行轨迹</span>
      </div>
      <div class="trace-toolbar-actions">
        <label class="threshold-field" title="模型调用耗时达到该值记「慢」">
          <span>慢 ≥</span>
          <el-input-number
            v-model="slowMsInput"
            :min="1000"
            :max="3600000"
            :step="1000"
            :controls="false"
            size="small"
            @change="applyThresholds"
          />
          <span>ms</span>
        </label>
        <label class="threshold-field" title="四类 token 之和达到该值记「贵」">
          <span>贵 ≥</span>
          <el-input-number
            v-model="expensiveTokensInput"
            :min="1000"
            :max="10000000"
            :step="1000"
            :controls="false"
            size="small"
            @change="applyThresholds"
          />
          <span>tokens</span>
        </label>
        <el-tooltip
          content="并行执行的工具耗时互相重叠，逐项相加会大于墙钟；墙钟取最早的开始到最晚的结束。工具按 tool_call_id 归轮；缺 id 的历史行按 created_at 归轮，时间戳完全相同时不猜轮，单独列为「未挂到轮」。"
          placement="bottom"
          :show-after="300"
        >
          <el-icon class="hint-icon" :size="14"><InfoFilled /></el-icon>
        </el-tooltip>
        <button type="button" class="trace-btn" :disabled="exporting" @click="exportJson">JSON</button>
        <button type="button" class="trace-btn" :disabled="exporting" @click="exportCsv">CSV</button>
        <button type="button" class="trace-btn" :disabled="loading" @click="reload">刷新</button>
      </div>
    </div>

    <div class="trace-scroll">
      <!-- 执行中的临时态：REST 要等工具 / 轮结束才有行，这里用 tool_call_start 本地走表 -->
      <div v-if="liveRound || liveTools.length > 0" class="live-card">
        <div class="live-head">
          <span class="live-dot"></span>
          <span class="live-title">执行中</span>
          <span v-if="liveRound" class="live-round">第 {{ liveRound.round }} 轮</span>
          <span v-if="liveRound?.inModelCall" class="live-phase">模型调用中</span>
        </div>
        <div v-for="tool in liveTools" :key="tool.toolCallId" class="live-tool">
          <span class="live-tool-name">{{ toolDisplayName(tool.name) }}</span>
          <span class="live-tool-elapsed">{{ formatElapsed(tool.startedAt) }}</span>
        </div>
      </div>

      <div v-if="loading && runs.length === 0" class="trace-empty">加载中…</div>
      <div v-else-if="runs.length === 0 && unattributed == null" class="trace-empty">暂无轨迹</div>

      <div
        v-for="run in runs"
        :key="run.runId"
        class="run-card"
        :class="`severity-${runSeverity(run)}`"
      >
        <button type="button" class="run-summary" @click="toggleRun(run.runId)">
          <el-icon class="run-caret" :size="12">
            <ArrowRight v-if="!isExpanded(run.runId)" />
            <ArrowDown v-else />
          </el-icon>
          <span class="run-preview" :title="run.userMessagePreview">{{ run.userMessagePreview || '(空消息)' }}</span>
          <span class="run-metrics">
            <span>墙钟 {{ formatMs(run.totals.wallClockMs) }}</span>
            <span>{{ formatTokens(tokenTotal(run)) }} tokens</span>
            <span v-if="run.totals.costMicros != null">成本 {{ formatCost(run.totals.costMicros) }}</span>
            <span :class="{ 'tool-error': run.totals.toolError > 0 }">
              工具 {{ run.totals.toolSuccess }}/{{ run.totals.toolError }}
            </span>
          </span>
          <span class="run-badges">
            <span v-for="badge in runBadges(run)" :key="badge.label" class="run-badge" :class="`badge-${badge.tone}`">
              {{ badge.label }}
            </span>
          </span>
        </button>

        <div v-if="isExpanded(run.runId)" class="run-detail">
          <div v-for="segment in run.segments" :key="segment.kind" class="trace-segment">
            <div class="segment-label">{{ segment.kind === 'before_edit' ? '编辑前' : '当前' }}</div>
            <div v-for="round in segment.rounds" :key="round.seq" class="round-row">
              <div class="round-head">
                <span class="round-seq">#{{ round.seq }}</span>
                <span class="round-model">{{ round.modelName ?? '未知模型' }}</span>
                <span class="round-scene">{{ llmCallSceneLabel(round.scene) }}</span>
                <span class="round-metrics">
                  <span>{{ formatMs(round.durationMs) }}</span>
                  <span>{{ formatTokens(tokenTotalOfRound(round)) }} tokens</span>
                  <span v-if="round.firstTokenMs != null">首字 {{ formatMs(round.firstTokenMs) }}</span>
                  <span v-if="round.retryCount > 0">重试 {{ round.retryCount }}</span>
                  <span v-if="round.costMicros != null">成本 {{ formatCost(round.costMicros) }}</span>
                </span>
                <span class="round-badges">
                  <span v-if="round.interrupted" class="run-badge badge-warn">中断</span>
                  <span v-else-if="!round.success" class="run-badge badge-danger">失败</span>
                  <span v-if="round.slow" class="run-badge badge-info">慢</span>
                  <span v-if="round.expensive" class="run-badge badge-info">贵</span>
                </span>
              </div>
              <div v-if="round.errorMessage" class="round-error">{{ round.errorMessage }}</div>
              <div v-for="tool in round.tools" :key="toolKey(tool)" class="tool-row">
                <span class="tool-status" :class="tool.status === 'ERROR' ? 'tool-error' : 'tool-ok'">
                  {{ tool.status === 'ERROR' ? '✕' : '✓' }}
                </span>
                <span v-if="tool.actor === 'user'" class="tool-actor" title="用户手动操作">用户</span>
                <span class="tool-name">{{ toolDisplayName(tool.name) }}</span>
                <span v-if="tool.target" class="tool-target" :title="tool.target">{{ tool.target }}</span>
                <span v-if="tool.approvalMark" class="tool-approval">{{ tool.approvalMark }}</span>
                <span class="tool-duration">{{ tool.durationMs == null ? '—' : formatMs(tool.durationMs) }}</span>
              </div>
            </div>
            <div v-if="segment.unplacedTools.length > 0" class="unplaced-tools">
              <div class="unplaced-label">未挂到轮</div>
              <div v-for="tool in segment.unplacedTools" :key="toolKey(tool)" class="tool-row">
                <span class="tool-status" :class="tool.status === 'ERROR' ? 'tool-error' : 'tool-ok'">
                  {{ tool.status === 'ERROR' ? '✕' : '✓' }}
                </span>
                <span v-if="tool.actor === 'user'" class="tool-actor" title="用户手动操作">用户</span>
                <span class="tool-name">{{ toolDisplayName(tool.name) }}</span>
                <span v-if="tool.target" class="tool-target" :title="tool.target">{{ tool.target }}</span>
                <span v-if="tool.approvalMark" class="tool-approval">{{ tool.approvalMark }}</span>
                <span class="tool-duration">{{ tool.durationMs == null ? '—' : formatMs(tool.durationMs) }}</span>
              </div>
            </div>
          </div>

          <div v-if="run.sideCalls.length > 0" class="side-calls">
            <div class="segment-label">旁路调用</div>
            <div v-for="(side, idx) in run.sideCalls" :key="idx" class="side-row">
              <span class="side-scene">{{ llmCallSceneLabel(side.scene) }}</span>
              <span class="side-model">{{ side.modelName ?? '未知模型' }}</span>
              <span class="side-metrics">
                <span>{{ formatMs(side.durationMs) }}</span>
                <span>{{ formatTokens(tokenTotalOfSide(side)) }} tokens</span>
                <span v-if="side.costMicros != null">成本 {{ formatCost(side.costMicros) }}</span>
              </span>
              <span v-if="!side.success" class="run-badge badge-danger">失败</span>
            </div>
          </div>

          <div v-if="run.subagentLinks.length > 0" class="subagent-links">
            <div class="segment-label">子代理</div>
            <div v-for="link in run.subagentLinks" :key="link.sessionId" class="subagent-link">
              <span class="subagent-title" :title="link.title ?? ''">{{ link.title || `会话 ${link.sessionId}` }}</span>
              <span class="subagent-id">#{{ link.sessionId }}</span>
            </div>
          </div>

          <div v-if="run.markers.length > 0" class="markers">
            <div v-for="marker in run.markers" :key="marker.atMessageId" class="marker-row">
              <span class="marker-label">上下文压缩</span>
              <span class="marker-detail" :title="marker.detail">{{ marker.detail }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 未归属组只在第一页、列表末尾：没有用户消息或早于首条用户消息的调用 / 活动 -->
      <div v-if="unattributed != null" class="unattributed-card">
        <button type="button" class="run-summary" @click="unattributedExpanded = !unattributedExpanded">
          <el-icon class="run-caret" :size="12">
            <ArrowRight v-if="!unattributedExpanded" />
            <ArrowDown v-else />
          </el-icon>
          <span class="run-preview">未归属（{{ unattributed.count }}）</span>
          <span class="run-metrics">
            <span v-if="unattributed.startedAt">{{ unattributed.startedAt }}</span>
            <span v-if="unattributed.endedAt">→ {{ unattributed.endedAt }}</span>
          </span>
        </button>
        <div v-if="unattributedExpanded" class="run-detail">
          <div v-for="round in unattributed.rounds" :key="round.seq" class="round-row">
            <div class="round-head">
              <span class="round-seq">#{{ round.seq }}</span>
              <span class="round-model">{{ round.modelName ?? '未知模型' }}</span>
              <span class="round-scene">{{ llmCallSceneLabel(round.scene) }}</span>
              <span class="round-metrics">
                <span>{{ formatMs(round.durationMs) }}</span>
                <span>{{ formatTokens(tokenTotalOfRound(round)) }} tokens</span>
              </span>
              <span class="round-badges">
                <span v-if="round.interrupted" class="run-badge badge-warn">中断</span>
                <span v-else-if="!round.success" class="run-badge badge-danger">失败</span>
              </span>
            </div>
            <div v-if="round.errorMessage" class="round-error">{{ round.errorMessage }}</div>
          </div>
          <div v-for="tool in unattributed.tools" :key="toolKey(tool)" class="tool-row">
            <span class="tool-status" :class="tool.status === 'ERROR' ? 'tool-error' : 'tool-ok'">
              {{ tool.status === 'ERROR' ? '✕' : '✓' }}
            </span>
            <span v-if="tool.actor === 'user'" class="tool-actor" title="用户手动操作">用户</span>
            <span class="tool-name">{{ toolDisplayName(tool.name) }}</span>
            <span v-if="tool.target" class="tool-target" :title="tool.target">{{ tool.target }}</span>
            <span class="tool-duration">{{ tool.durationMs == null ? '—' : formatMs(tool.durationMs) }}</span>
          </div>
        </div>
      </div>

      <div v-if="hasMore" class="load-more">
        <button type="button" class="trace-btn" :disabled="loading" @click="loadMore">
          {{ loading ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowRight, InfoFilled, TrendCharts } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useSessionStore } from '../../stores/session'
import { getToolDisplayName } from '../../utils/toolDisplay'
import { llmCallSceneLabel } from '../../utils/llmCallLabels'
import { downloadTraceCsv, downloadTraceJson } from '../../utils/trace-export'
import type { RunTrace, RunTracePage, TraceRound, TraceSideCall, TraceTool, UnattributedGroup } from '../../types/trace'

const props = defineProps<{
  sessionId: string
}>()

const sessionStore = useSessionStore()

const SLOW_MS_MIN = 1_000
const SLOW_MS_MAX = 3_600_000
const EXPENSIVE_MIN = 1_000
const EXPENSIVE_MAX = 10_000_000
const TERMINAL_PHASES = new Set(['IDLE', 'COMPLETED', 'FAILED', 'CANCELLED'])

const runs = computed(() => sessionStore.getTraceRuns(props.sessionId))
const hasMore = computed(() => sessionStore.getTraceHasMore(props.sessionId))
const unattributed = computed(() => sessionStore.getTraceUnattributed(props.sessionId))
const loading = computed(() => sessionStore.isTraceLoading(props.sessionId))

const expandedRuns = ref<Set<number>>(new Set())
const unattributedExpanded = ref(false)
const exporting = ref(false)
/** 已加载的页数：执行结束后按同样页数重拉，避免把用户翻出来的历史页丢掉 */
const loadedPages = ref(1)

const slowMsInput = ref(sessionStore.traceThresholds.slowMs)
const expensiveTokensInput = ref(sessionStore.traceThresholds.expensiveTokens)
watch(() => sessionStore.traceThresholds, (value) => {
  slowMsInput.value = value.slowMs
  expensiveTokensInput.value = value.expensiveTokens
}, { deep: true })

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function applyThresholds() {
  sessionStore.setTraceThresholds({
    slowMs: clamp(slowMsInput.value, SLOW_MS_MIN, SLOW_MS_MAX),
    expensiveTokens: clamp(expensiveTokensInput.value, EXPENSIVE_MIN, EXPENSIVE_MAX),
  })
  void reload()
}

async function fetchTracePage(beforeRunId: number | null, limit: number): Promise<RunTracePage> {
  const { data } = await api.get(`/sessions/${props.sessionId}/trace`, {
    params: {
      limit,
      beforeRunId: beforeRunId ?? undefined,
      slowMs: sessionStore.traceThresholds.slowMs,
      expensiveTokens: sessionStore.traceThresholds.expensiveTokens,
    },
  })
  return data as RunTracePage
}

/** 首页整页替换（首次打开 / 阈值变更 / 执行结束后重拉）。 */
async function loadFirstPage() {
  sessionStore.setTraceLoading(props.sessionId, true)
  try {
    const page = await fetchTracePage(null, 5)
    sessionStore.setTracePage(props.sessionId, page)
    loadedPages.value = 1
  } catch {
    /* 拦截器已提示 */
  } finally {
    sessionStore.setTraceLoading(props.sessionId, false)
  }
}

/** 执行结束后按当前已加载页数重拉：进行中的 run 结束后才落库，不重拉就看不到。 */
async function refetchLoadedPages() {
  const pages = Math.max(1, loadedPages.value)
  const collected: RunTrace[] = []
  let beforeRunId: number | null = null
  let pageHasMore = false
  let firstUnattributed: UnattributedGroup | null = null
  for (let i = 0; i < pages; i++) {
    const page = await fetchTracePage(beforeRunId, 5)
    if (i === 0) firstUnattributed = page.unattributed
    collected.push(...page.runs)
    pageHasMore = page.hasMore
    if (!pageHasMore || page.runs.length === 0) break
    beforeRunId = page.runs[page.runs.length - 1]!.runId
  }
  sessionStore.setTracePage(props.sessionId, { runs: collected, hasMore: pageHasMore, unattributed: firstUnattributed })
  loadedPages.value = pages
}

function reload() {
  void loadFirstPage()
}

async function loadMore() {
  const current = runs.value
  const last = current[current.length - 1]
  if (last == null) return
  sessionStore.setTraceLoading(props.sessionId, true)
  try {
    const page = await fetchTracePage(last.runId, 5)
    sessionStore.appendTracePage(props.sessionId, page)
    loadedPages.value += 1
  } catch {
    /* 拦截器已提示 */
  } finally {
    sessionStore.setTraceLoading(props.sessionId, false)
  }
}

onMounted(() => {
  // KeepAlive 逐出后重挂载 / 首次打开同一条路径：按当前会话重拉
  void loadFirstPage()
})

// 兜底：轨迹 Tab 每会话同 id（'trace'），若实例被跨会话复用（key 不含会话维度），
// 只触发 props 变化而不重挂载，此时必须自己重拉，否则显示的是上一个会话的轨迹
watch(() => props.sessionId, () => {
  loadedPages.value = 1
  void loadFirstPage()
})

// 执行终止后重拉：run 的 llm_call / 活动都是结束时才落库，临时行丢掉后以 REST 为准
watch(
  () => sessionStore.getSessionPhase(props.sessionId),
  (phase, prev) => {
    if (phase == null || !TERMINAL_PHASES.has(phase)) return
    if (prev == null || TERMINAL_PHASES.has(prev)) return
    void refetchLoadedPages().catch(() => { /* 拦截器已提示 */ })
  }
)

// ===== 进行中临时态 =====
const liveExecutionId = computed(() => sessionStore.getLiveExecutionId(props.sessionId))
const liveRound = computed(() =>
  liveExecutionId.value != null ? sessionStore.getLiveRound(props.sessionId, liveExecutionId.value) : null
)
const liveTools = computed(() =>
  liveExecutionId.value != null ? sessionStore.getLiveTools(props.sessionId, liveExecutionId.value) : []
)

// 本地走表：duration_ms 要等工具结束才有，回答不了「卡了多久」
const nowTick = ref(Date.now())
let tickTimer: number | null = null

watch(liveTools, (list) => {
  if (list.length > 0 && tickTimer == null) {
    tickTimer = window.setInterval(() => { nowTick.value = Date.now() }, 1000)
  } else if (list.length === 0 && tickTimer != null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
}, { immediate: true })

onUnmounted(() => {
  if (tickTimer != null) window.clearInterval(tickTimer)
})

function formatElapsed(startedAt: number): string {
  void nowTick.value
  return formatMs(Date.now() - startedAt)
}

// ===== 展示格式化 =====
function formatMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatTokens(tokens: number): string {
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(1)}k`
  return tokens.toLocaleString('zh-CN')
}

function formatCost(costMicros: number): string {
  const value = costMicros / 1_000_000
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function tokenTotal(run: RunTrace): number {
  const t = run.totals
  return t.promptTokens + t.completionTokens + t.cachedTokens + t.cacheCreationTokens
}

function tokenTotalOfRound(round: TraceRound): number {
  return round.promptTokens + round.completionTokens + round.cachedTokens + round.cacheCreationTokens
}

function tokenTotalOfSide(side: TraceSideCall): number {
  return side.promptTokens + side.completionTokens + side.cachedTokens + side.cacheCreationTokens
}

function toolDisplayName(name: string): string {
  return getToolDisplayName(name)
}

function toolKey(tool: TraceTool): string {
  return `${tool.toolCallId ?? ''}|${tool.target ?? ''}|${tool.name}`
}

interface RunBadge { label: string; tone: 'neutral' | 'danger' | 'warn' | 'info' }

function runBadges(run: RunTrace): RunBadge[] {
  const rounds = run.segments.flatMap((s) => s.rounds)
  const badges: RunBadge[] = []
  if (run.markers.length > 0) badges.push({ label: '压缩', tone: 'neutral' })
  if (rounds.some((r) => !r.success && !r.interrupted)) badges.push({ label: '失败', tone: 'danger' })
  if (rounds.some((r) => r.interrupted)) badges.push({ label: '中断', tone: 'warn' })
  if (rounds.some((r) => r.retryCount > 0)) badges.push({ label: '重试', tone: 'warn' })
  if (rounds.some((r) => r.slow)) badges.push({ label: '慢', tone: 'info' })
  if (rounds.some((r) => r.expensive)) badges.push({ label: '贵', tone: 'info' })
  if (run.segments.some((s) => s.kind === 'before_edit')) badges.push({ label: '编辑前', tone: 'neutral' })
  return badges
}

/** 摘要条按最高严重度描边：失败红，重试与中断黄，慢与贵中性色。 */
function runSeverity(run: RunTrace): 'error' | 'warn' | 'info' | 'none' {
  const rounds = run.segments.flatMap((s) => s.rounds)
  if (rounds.some((r) => !r.success && !r.interrupted)) return 'error'
  if (rounds.some((r) => r.interrupted || r.retryCount > 0)) return 'warn'
  if (rounds.some((r) => r.slow || r.expensive)) return 'info'
  return 'none'
}

function isExpanded(runId: number): boolean {
  return expandedRuns.value.has(runId)
}

function toggleRun(runId: number) {
  const next = new Set(expandedRuns.value)
  if (next.has(runId)) next.delete(runId)
  else next.add(runId)
  expandedRuns.value = next
}

// ===== 导出 =====
async function fetchAllPages(): Promise<{ runs: RunTrace[]; unattributed: UnattributedGroup | null }> {
  const collected: RunTrace[] = []
  let beforeRunId: number | null = null
  let pageUnattributed: UnattributedGroup | null = null
  // 兜底上限：正常会话远小于 200 页，防后端异常时无限翻页
  for (let guard = 0; guard < 200; guard++) {
    const page = await fetchTracePage(beforeRunId, 50)
    if (guard === 0) pageUnattributed = page.unattributed
    if (page.runs.length === 0) break
    collected.push(...page.runs)
    if (!page.hasMore) break
    beforeRunId = page.runs[page.runs.length - 1]!.runId
  }
  return { runs: collected, unattributed: pageUnattributed }
}

async function exportJson() {
  exporting.value = true
  try {
    const payload = await fetchAllPages()
    if (payload.runs.length === 0 && payload.unattributed == null) {
      ElMessage.warning('没有可导出的轨迹')
      return
    }
    downloadTraceJson(payload, props.sessionId)
  } catch {
    /* 拦截器已提示 */
  } finally {
    exporting.value = false
  }
}

async function exportCsv() {
  exporting.value = true
  try {
    const payload = await fetchAllPages()
    if (payload.runs.length === 0 && payload.unattributed == null) {
      ElMessage.warning('没有可导出的轨迹')
      return
    }
    downloadTraceCsv(payload, props.sessionId)
  } catch {
    /* 拦截器已提示 */
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.run-trace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aw-canvas);
}

.trace-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aw-space-xs);
  padding: var(--aw-space-xxs) var(--aw-space-xs);
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-wrap: wrap;
}

.trace-toolbar-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.trace-toolbar-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  flex-wrap: wrap;
}

.threshold-field {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.threshold-field :deep(.el-input-number) {
  width: 76px;
}

.threshold-field :deep(.el-input__wrapper) {
  padding: 1px 6px;
}

.threshold-field :deep(.el-input__inner) {
  font-size: var(--aw-text-fine);
  text-align: right;
}

.hint-icon {
  color: var(--aw-ink-muted-40);
  cursor: help;
}

.trace-btn {
  font-size: var(--aw-text-fine);
  font-family: var(--aw-font-text);
  padding: 3px 9px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-surface);
  color: var(--aw-ink-muted-64);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.trace-btn:hover:not(:disabled) {
  color: var(--aw-primary);
  border-color: var(--aw-primary-line);
  background: var(--aw-primary-hover);
}

.trace-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.trace-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--aw-space-xxs);
}

.trace-empty {
  padding: var(--aw-space-md);
  text-align: center;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-40);
}

/* ===== 执行中临时态 ===== */
.live-card {
  border: 1px solid var(--aw-primary-line);
  background: var(--aw-primary-soft);
  border-radius: var(--aw-radius-sm);
  padding: var(--aw-space-xxs) var(--aw-space-xs);
  margin-bottom: var(--aw-space-xxs);
}

.live-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aw-primary);
  animation: live-pulse 1.2s ease-in-out infinite;
}

@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.live-title {
  font-weight: 600;
}

.live-phase {
  color: var(--aw-ink-muted-48);
}

.live-tool {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aw-space-xs);
  padding: 2px 0 2px 12px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.live-tool-elapsed {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

/* ===== run 摘要条 ===== */
.run-card {
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  margin-bottom: var(--aw-space-xxs);
  background: var(--aw-surface);
  overflow: hidden;
}

.run-card.severity-error {
  border-color: var(--aw-danger);
}

.run-card.severity-warn {
  border-color: var(--aw-warning);
}

.run-card.severity-info {
  border-color: var(--aw-hairline);
}

.run-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px var(--aw-space-xxs);
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: var(--aw-font-text);
}

.run-summary:hover {
  background: var(--aw-surface-hover);
}

.run-caret {
  color: var(--aw-ink-muted-40);
  flex-shrink: 0;
}

.run-preview {
  flex: 1;
  min-width: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.run-metrics {
  display: inline-flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-mono);
  color: var(--aw-ink-muted-48);
}

.run-badges {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.run-badge {
  font-size: var(--aw-text-micro);
  padding: 1px 5px;
  border-radius: var(--aw-radius-xs);
  line-height: 1.4;
  white-space: nowrap;
}

.badge-neutral {
  color: var(--aw-ink-muted-64);
  background: rgba(0, 0, 0, 0.05);
}

.badge-danger {
  color: var(--aw-danger);
  background: var(--aw-diff-del-bg);
}

.badge-warn {
  color: var(--aw-status-waiting);
  background: var(--aw-status-waiting-bg);
}

.badge-info {
  color: var(--aw-diff-info);
  background: var(--aw-diff-info-bg);
}

/* ===== 展开明细 ===== */
.run-detail {
  border-top: 1px solid var(--aw-divider-soft);
  padding: var(--aw-space-xxs);
}

.trace-segment + .trace-segment {
  margin-top: var(--aw-space-xxs);
}

.segment-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  padding: 2px 0;
}

.round-row {
  padding: 3px 0 3px 6px;
  border-left: 2px solid var(--aw-divider-soft);
}

.round-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--aw-text-fine);
}

.round-seq {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink-muted-48);
}

.round-model {
  color: var(--aw-ink);
}

.round-scene {
  color: var(--aw-ink-muted-40);
}

.round-metrics {
  display: inline-flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.round-badges {
  display: inline-flex;
  gap: 3px;
}

.round-error {
  font-size: var(--aw-text-micro);
  color: var(--aw-danger);
  padding: 2px 0 2px 6px;
  word-break: break-all;
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0 1px 14px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.tool-status {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
}

.tool-status.tool-ok {
  color: var(--aw-success);
}

.tool-status.tool-error {
  color: var(--aw-danger);
}

.tool-name {
  flex-shrink: 0;
}

.tool-actor {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  color: var(--aw-primary);
}

.tool-target {
  flex: 1;
  min-width: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-approval {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  color: var(--aw-status-waiting);
}

.tool-duration {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.unplaced-tools {
  margin: 2px 0 2px 6px;
  padding-left: 6px;
  border-left: 2px dashed var(--aw-hairline);
}

.unplaced-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  padding: 2px 0;
}

.side-calls,
.subagent-links,
.markers {
  margin-top: var(--aw-space-xxs);
}

.side-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0 1px 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.side-model {
  color: var(--aw-ink);
}

.side-metrics {
  display: inline-flex;
  gap: var(--aw-space-xxs);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.subagent-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0 1px 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.subagent-title {
  max-width: 60%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subagent-id {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
}

.marker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0 1px 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.marker-label {
  color: var(--aw-diff-info);
}

.marker-detail {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unattributed-card {
  border: 1px dashed var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  margin-bottom: var(--aw-space-xxs);
  background: var(--aw-surface-pearl);
  overflow: hidden;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: var(--aw-space-xxs) 0 var(--aw-space-xs);
}

/* Dark mode */
[data-theme="dark"] .run-card,
[data-theme="dark"] .unattributed-card {
  background: var(--aw-surface-pearl);
}

[data-theme="dark"] .badge-neutral {
  background: rgba(255, 255, 255, 0.08);
}

[data-theme="dark"] .run-summary:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
