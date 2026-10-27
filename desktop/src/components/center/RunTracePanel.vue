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
        <label class="threshold-field" title="模型调用成本达到该值记「贵」；模型未配置价格时不算贵">
          <span>贵 ≥</span>
          <el-input-number
            v-model="expensiveCostInput"
            :min="0.001"
            :max="1000"
            :precision="3"
            :step="0.1"
            :controls="false"
            size="small"
            @change="applyThresholds"
          />
          <span>元</span>
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
      <!-- L0 会话总览：先回答「整体怎么样」，再下钻到单个 run -->
      <div v-if="runs.length > 0" class="trace-overview">
        <div class="overview-line">
          <span class="overview-count">最近 {{ runs.length }} 次任务</span>
          <span class="overview-ok">{{ traceSummary.ok }} 成功</span>
          <span v-if="traceSummary.error > 0" class="overview-error">{{ traceSummary.error }} 失败</span>
          <span v-if="traceSummary.interrupted > 0" class="overview-interrupted">{{ traceSummary.interrupted }} 中断</span>
        </div>
        <div class="overview-metrics">
          <span>总耗时 {{ formatMs(traceSummary.wallClockMs) }}</span>
          <span>{{ formatTokens(traceSummary.tokens) }} tokens</span>
          <span v-if="traceSummary.costMicros != null">总成本 {{ formatCost(traceSummary.costMicros) }}</span>
          <span v-if="toolRate != null">工具成功率 {{ toolRate }}%</span>
        </div>
      </div>

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
          <span v-if="formatClock(run.startedAt)" class="run-clock" :title="run.startedAt ?? ''">{{ formatClock(run.startedAt) }}</span>
          <span class="run-status" :class="`status-${runStatus(run)}`" :title="RUN_STATUS_META[runStatus(run)].label">
            <el-icon :size="13">
              <CircleCheck v-if="runStatus(run) === 'ok'" />
              <CircleClose v-else-if="runStatus(run) === 'error'" />
              <WarningFilled v-else />
            </el-icon>
          </span>
          <!-- 消息预览不带自己的点击入口：整行（含任务名）只做展开 / 收起切换；
               完整原文入口在展开区顶部「查看原文」（预览曾独占点击并把 toggle 拦掉） -->
          <span class="run-preview">{{ run.userMessagePreview || '(空消息)' }}</span>
          <span class="run-metrics">
            <span>耗时 {{ formatMs(run.totals.wallClockMs) }}</span>
            <span>{{ formatTokens(tokenTotal(run)) }} tokens</span>
          </span>
          <span class="run-badges">
            <span v-for="badge in runAttentionBadges(run)" :key="badge.label" class="run-badge" :class="`badge-${badge.tone}`">{{ badge.label }}</span>
          </span>
        </button>

        <div v-if="isExpanded(run.runId)" class="run-detail">
          <!-- 时间概览条带：run 展开区顶部，与该 run 时间域对齐；点击色条定位到对应行 -->
          <RunTraceTimeBand
            :run="run"
            :active-run-key="activeBandKey"
            @locate="(key: string) => locateNode(run.runId, key)"
          />
          <!-- 消息原文入口：run 锚点 id 就是 runId，按主键直查该条用户消息。
               常驻可见——摘要行的点击已让位给展开切换，这里是唯一入口 -->
          <div class="run-origin-row">
            <button
              type="button"
              class="run-origin-btn"
              title="查看该任务的用户消息完整原文"
              @click="openMessageRecord(run.runId)"
            >查看原文</button>
          </div>
          <div v-for="segment in run.segments" :key="segment.kind" class="trace-segment">
            <div class="segment-label">{{ segment.kind === 'before_edit' ? '编辑前' : '当前' }}</div>
            <div v-for="round in segment.rounds" :key="`${segment.kind}-${round.seq}`" :id="rowAnchorId(run.runId, 'round', roundAnchorKey(segment.kind, round.seq))" class="round-row">
              <div class="round-head">
                <span class="round-seq">#{{ round.seq }}</span>
                <span class="round-model">{{ round.modelName ?? '未知模型' }}</span>
                <span v-if="round.provider" class="round-provider" :title="`模型提供方 ${round.provider}`">{{ round.provider }}</span>
                <span class="round-scene">{{ llmCallSceneLabel(round.scene) }}</span>
                <span class="round-metrics">
                  <span>{{ formatMs(round.durationMs) }}</span>
                  <span v-if="decodingMs(round) != null" title="解码耗时 = 总耗时 − 首字耗时">解码 {{ formatMs(decodingMs(round)) }}</span>
                  <span v-if="throughput(round) != null" title="吞吐量 = 输出 tokens ÷ 解码耗时">{{ formatThroughput(round) }}</span>
                  <span v-if="round.firstTokenMs != null">首字 {{ formatMs(round.firstTokenMs) }}</span>
                  <span>{{ formatTokens(tokenTotalOfRound(round)) }} tokens</span>
                  <span v-if="round.costMicros != null">成本 {{ formatCost(round.costMicros) }}</span>
                </span>
                <span class="round-badges">
                  <span v-if="round.interrupted" class="run-badge badge-warn">中断</span>
                  <span v-else-if="!round.success" class="run-badge badge-danger">失败</span>
                  <span v-if="round.retryCount > 0" class="run-badge badge-warn">重试 {{ round.retryCount }}</span>
                  <span v-if="round.slow" class="run-badge badge-info">慢</span>
                  <span v-if="round.expensive" class="run-badge badge-info">贵</span>
                  <button
                    v-if="round.llmCallId != null"
                    type="button"
                    class="row-detail-btn"
                    title="查看本轮请求元信息与工具清单"
                    @click="openCallRecord(round.llmCallId)"
                  >详情</button>
                </span>
              </div>
              <div v-if="round.errorMessage" class="round-error">{{ round.errorMessage }}</div>
              <div v-for="tool in round.tools" :key="toolRowKey(run, tool)" :id="rowAnchorId(run.runId, 'tool', toolRowAnchor(run, tool))" class="tool-row">
                <span class="tool-status" :class="tool.status === 'ERROR' ? 'tool-error' : 'tool-ok'">
                  {{ tool.status === 'ERROR' ? '✕' : '✓' }}
                </span>
                <span v-if="tool.actor === 'user'" class="tool-actor" title="用户手动操作">用户</span>
                <span class="tool-name">{{ toolDisplayName(tool.name) }}</span>
                <span v-if="tool.target" class="tool-target" :title="tool.target">{{ tool.target }}</span>
                <span v-if="tool.approvalMark" class="tool-approval">{{ tool.approvalMark }}</span>
                <span class="tool-duration">{{ tool.durationMs == null ? '—' : formatMs(tool.durationMs) }}</span>
                <button
                  v-if="tool.toolCallId"
                  type="button"
                  class="row-detail-btn"
                  title="查看本次调用的参数与结果"
                  @click="openToolRecord(tool.toolCallId)"
                >详情</button>
              </div>
            </div>
            <div v-if="segment.unplacedTools.length > 0" class="unplaced-tools">
              <div class="unplaced-label">未挂到轮</div>
              <div v-for="tool in segment.unplacedTools" :key="toolRowKey(run, tool)" :id="rowAnchorId(run.runId, 'tool', toolRowAnchor(run, tool))" class="tool-row">
                <span class="tool-status" :class="tool.status === 'ERROR' ? 'tool-error' : 'tool-ok'">
                  {{ tool.status === 'ERROR' ? '✕' : '✓' }}
                </span>
                <span v-if="tool.actor === 'user'" class="tool-actor" title="用户手动操作">用户</span>
                <span class="tool-name">{{ toolDisplayName(tool.name) }}</span>
                <span v-if="tool.target" class="tool-target" :title="tool.target">{{ tool.target }}</span>
                <span v-if="tool.approvalMark" class="tool-approval">{{ tool.approvalMark }}</span>
                <span class="tool-duration">{{ tool.durationMs == null ? '—' : formatMs(tool.durationMs) }}</span>
                <button
                  v-if="tool.toolCallId"
                  type="button"
                  class="row-detail-btn"
                  title="查看本次调用的参数与结果"
                  @click="openToolRecord(tool.toolCallId)"
                >详情</button>
              </div>
            </div>
          </div>

          <div v-if="run.sideCalls.length > 0" class="side-calls">
            <div class="segment-label">旁路调用</div>
            <div v-for="(side, idx) in run.sideCalls" :key="idx" :id="rowAnchorId(run.runId, 'side', idx)" class="side-row">
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
                <span v-if="round.retryCount > 0" class="run-badge badge-warn">重试 {{ round.retryCount }}</span>
              </span>
            </div>
            <div v-if="round.errorMessage" class="round-error">{{ round.errorMessage }}</div>
          </div>
          <div v-for="(tool, toolIndex) in unattributed.tools" :key="`${toolKey(tool)}|${toolIndex}`" class="tool-row">
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

    <!-- 记录详情抽屉：面板内 absolute 定位，不挂全局侧边栏（el-drawer 的 append-to-body
         会带出跨会话错配类问题，抽屉的 sessionId 上下文必须严格属于本面板） -->
    <RunTraceRecordDrawer
      v-if="drawerTarget != null"
      :session-id="props.sessionId"
      :target="drawerTarget"
      @close="drawerTarget = null"
      @open-tool="openToolRecord"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowRight, CircleCheck, CircleClose, InfoFilled, TrendCharts, WarningFilled } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useSessionStore } from '../../stores/session'
import { getToolDisplayName } from '../../utils/toolDisplay'
import { llmCallSceneLabel } from '../../utils/llmCallLabels'
import { downloadTraceCsv, downloadTraceJson } from '../../utils/trace-export'
import {
  decodingMs, formatClock, formatTokens, RUN_STATUS_META, runAttentionBadges, runStatus, summarizeRuns,
  throughput, formatThroughput, toolSuccessRate, toolAnchorKey as toolAnchorKeyOf, runTimeNodes,
} from '../../utils/trace-display'
import RunTraceTimeBand from './RunTraceTimeBand.vue'
import RunTraceRecordDrawer from './RunTraceRecordDrawer.vue'
import type { RunTrace, RunTracePage, TraceRound, TraceSideCall, TraceTool, UnattributedGroup } from '../../types/trace'
import type { TraceDrawerTarget } from '../../types/trace'

const props = defineProps<{
  sessionId: string
}>()

const sessionStore = useSessionStore()

const SLOW_MS_MIN = 1_000
const SLOW_MS_MAX = 3_600_000
const COST_MIN = 0.001
const COST_MAX = 1000
const TERMINAL_PHASES = new Set(['IDLE', 'COMPLETED', 'FAILED', 'CANCELLED'])

const runs = computed(() => sessionStore.getTraceRuns(props.sessionId))
const hasMore = computed(() => sessionStore.getTraceHasMore(props.sessionId))
const unattributed = computed(() => sessionStore.getTraceUnattributed(props.sessionId))
const loading = computed(() => sessionStore.isTraceLoading(props.sessionId))

/** L0 会话总览：先回答「整体怎么样」，再下钻到单个 run */
const traceSummary = computed(() => summarizeRuns(runs.value))
const toolRate = computed(() => toolSuccessRate(traceSummary.value))

const expandedRuns = ref<Set<number>>(new Set())
const unattributedExpanded = ref(false)
const exporting = ref(false)
/** 已加载的页数：执行结束后按同样页数重拉，避免把用户翻出来的历史页丢掉 */
const loadedPages = ref(1)

const slowMsInput = ref(sessionStore.traceThresholds.slowMs)
const expensiveCostInput = ref(sessionStore.traceThresholds.expensiveCost)
watch(() => sessionStore.traceThresholds, (value) => {
  slowMsInput.value = value.slowMs
  expensiveCostInput.value = value.expensiveCost
}, { deep: true })

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 金额阈值保留小数：0.5 元这类输入不能被取整成 0。 */
function clampCost(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function applyThresholds() {
  sessionStore.setTraceThresholds({
    slowMs: clamp(slowMsInput.value, SLOW_MS_MIN, SLOW_MS_MAX),
    expensiveCost: clampCost(expensiveCostInput.value, COST_MIN, COST_MAX),
  })
  void reload()
}

async function fetchTracePage(beforeRunId: number | null, limit: number): Promise<RunTracePage> {
  const { data } = await api.get(`/sessions/${props.sessionId}/trace`, {
    params: {
      limit,
      beforeRunId: beforeRunId ?? undefined,
      slowMs: sessionStore.traceThresholds.slowMs,
      expensiveCost: sessionStore.traceThresholds.expensiveCost,
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

// 兜底：正常情况下 key（trace-{会话 id}）变化会重挂载并重拉；万一实例被复用、
// 只触发 props 变化，必须自己重拉，否则显示的是上一个会话的轨迹
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

function formatCost(costMicros: number): string {
  const value = costMicros / 1_000_000
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function tokenTotal(run: RunTrace): number {
  const t = run.totals
  return t.promptTokens + t.completionTokens
}

function tokenTotalOfRound(round: TraceRound): number {
  return round.promptTokens + round.completionTokens
}

function tokenTotalOfSide(side: TraceSideCall): number {
  return side.promptTokens + side.completionTokens
}

function toolDisplayName(name: string): string {
  return getToolDisplayName(name)
}

/** 工具行 :key 与条带定位 key 的唯一口径，实现在 utils/trace-display.ts（与条带节点同源）。 */
function toolKey(tool: TraceTool): string {
  return toolAnchorKeyOf(tool)
}

/**
 * 工具节点 key 反查：runTimeNodes 的遍历顺序（每段先 unplacedTools 再 rounds.tools）与
 * 序号是唯一口径。行锚点直接复用条带 key，避免两处各自编号（曾经行用列表内下标、
 * 条带用跨段全局序号，导致第 2 轮之后的工具色条点击定位不到行）。
 * WeakMap 以 run 对象为键缓存，同一 run 的多行 / 多次渲染只算一次。
 */
const toolBandKeysByRun = new WeakMap<RunTrace, Map<TraceTool, string>>()
function toolBandKeyMap(run: RunTrace): Map<TraceTool, string> {
  const cached = toolBandKeysByRun.get(run)
  if (cached != null) return cached
  const map = new Map<TraceTool, string>()
  for (const node of runTimeNodes(run)) {
    if (node.toolRef != null) map.set(node.toolRef, node.key)
  }
  toolBandKeysByRun.set(run, map)
  return map
}

/** 行 :key 直接用条带 key（含段维度 + 全局序号），同 toolCallId/target/name 也不会重复。 */
function toolRowKey(run: RunTrace, tool: TraceTool): string {
  return toolBandKeyMap(run).get(tool) ?? toolAnchorKeyOf(tool)
}

/** 行锚点 key = 条带 key 去掉 `tool:` 前缀（locateNode 已按同样规则剥前缀）。 */
function toolRowAnchor(run: RunTrace, tool: TraceTool): string {
  const key = toolRowKey(run, tool)
  return key.startsWith('tool:') ? key.slice('tool:'.length) : key
}

/**
 * 轮次行锚点 key：与条带节点 key 同口径（`${segment.kind}:${seq}`）。
 * 必须带段维度——编辑重发时 before_edit / current 两段各自从 1 编号，只用 seq 会撞。
 */
function roundAnchorKey(segmentKind: string, seq: number): string {
  return `${segmentKind}:${seq}`
}

/**
 * 行锚点 id：sessionId + runId + kind + key 四个维度都要带。
 * sessionId 防多个轨迹 Tab 并存串锚；runId 防同一会话内多个 run 同时展开串锚
 * （expandedRuns 是 Set，可同时展开多个 run，两段的 seq 又各自从 1 起）；
 * key 里的段维度防编辑重发的 before_edit / current 两段相撞。
 */
function rowAnchorId(runId: number, kind: 'round' | 'tool' | 'side', key: string | number): string {
  return `trace-${props.sessionId}-run${runId}-${kind}-${key}`
}

// ===== 时间条带点击定位 =====
/** 当前定位到的节点：runId + key 一起记，避免多个展开 run 的同名色条一起高亮 */
const activeBandKey = ref<string | null>(null)

/**
 * 条带色条点击：确保该 run 已展开 → nextTick 后按行锚点滚动定位 → 该行加 1.2s 高亮后移除。
 * 行不存在（如条带节点的工具行在另一段）时静默返回：定位是辅助操作，不该弹错误打扰。
 * key 形如 `round:${段}:${seq}` / `tool:${段}:${toolCallId}` / `side:${index}`，后半段
 * （toolCallId）自身可能含冒号，所以按第一个冒号切，余下整段都当 key。
 */
async function locateNode(runId: number, key: string) {
  activeBandKey.value = `${runId}|${key}`
  const sep = key.indexOf(':')
  if (sep <= 0) return
  const kind = key.slice(0, sep)
  const rawKey = key.slice(sep + 1)
  if (rawKey === '') return
  const anchor = rowAnchorId(runId, kind as 'round' | 'tool' | 'side', rawKey)
  await nextTick()
  const row = document.getElementById(anchor)
  if (row == null) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.add('row-located')
  window.setTimeout(() => { row.classList.remove('row-located') }, 1200)
}

// ===== 记录详情抽屉 =====
const drawerTarget = ref<TraceDrawerTarget | null>(null)

function openToolRecord(toolCallId: string) {
  drawerTarget.value = { kind: 'tool', toolCallId }
}

function openCallRecord(llmCallId: number) {
  drawerTarget.value = { kind: 'call', llmCallId }
}

/** run 锚点 id 就是 runId（run-trace.service 的归属口径）：按主键直查该条用户消息。 */
function openMessageRecord(runId: number) {
  drawerTarget.value = { kind: 'message', messageId: runId }
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
  /* 记录详情抽屉 .record-drawer-layer 是 position: absolute，需要定位祖先做包含块；
     否则包含块回落到初始包含块（视口），遮罩会铺满整个屏幕、抽屉右边缘贴屏幕右边。 */
  position: relative;
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
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
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

/* ===== L0 会话总览 ===== */
.trace-overview {
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
  padding: var(--aw-space-xxs) var(--aw-space-xs);
  margin-bottom: var(--aw-space-xxs);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.overview-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.overview-count {
  font-weight: 600;
  color: var(--aw-ink);
}

.overview-error {
  color: var(--aw-danger);
}

.overview-interrupted {
  color: var(--aw-status-waiting);
}

.overview-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aw-space-xxs);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
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

/* 消息原文入口：展开区常驻小按钮（抽屉的唯一入口，不能只悬停可见），
   配色与下钻按钮同系但默认可见、带淡描边 */
.run-origin-row {
  display: flex;
  justify-content: flex-end;
  padding: 2px 0;
}

.run-origin-btn {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-text);
  height: 16px;
  padding: 0 5px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-divider-soft);
  background: transparent;
  color: var(--aw-ink-muted-40);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.run-origin-btn:hover {
  color: var(--aw-primary);
  border-color: var(--aw-primary-line);
  background: var(--aw-primary-hover);
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

/* 时间锚点与结果状态：正常 run 只剩灰时间 + 绿勾，异常才被看见 */
.run-clock {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.run-status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.run-status.status-ok {
  color: var(--aw-success);
}

.run-status.status-error {
  color: var(--aw-danger);
}

.run-status.status-interrupted {
  color: var(--aw-status-waiting);
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

/* provider 徽标：小号中性色，跟在模型名后，不抢轮次行的主信息 */
.round-provider {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  padding: 0 4px;
  border-radius: var(--aw-radius-xs);
  line-height: 1.5;
  color: var(--aw-ink-muted-64);
  background: rgba(0, 0, 0, 0.05);
}

[data-theme="dark"] .round-provider {
  background: rgba(255, 255, 255, 0.08);
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

/* 下钻入口：默认极淡，悬停/聚焦才显形——轨迹行以摘要为主，不该被一排按钮稀释 */
.row-detail-btn {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-text);
  height: 16px;
  padding: 0 5px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid transparent;
  background: transparent;
  color: var(--aw-ink-muted-40);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}

.round-row:hover .row-detail-btn,
.tool-row:hover .row-detail-btn,
.row-detail-btn:focus-visible {
  opacity: 1;
}

.row-detail-btn:hover {
  color: var(--aw-primary);
  border-color: var(--aw-primary-line);
  background: var(--aw-primary-hover);
}

/* 条带点击定位的高亮：1.2s 后由 JS 移除，不靠 transition 残留 */
.row-located {
  animation: row-locate-flash 1.2s ease-out;
}

@keyframes row-locate-flash {
  0%, 60% { background: var(--aw-primary-soft); }
  100% { background: transparent; }
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
