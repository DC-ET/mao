<template>
  <div class="overview-tab">
    <el-card class="block">
      <div class="metric-strip" v-loading="loading">
        <div class="metric primary">
          <div class="label">Token 消耗</div>
          <div class="value-row">
            <span class="value">{{ formatTokens(totalTokens) }}</span>
            <span v-if="tokenDelta !== null" class="delta" :class="deltaClass(tokenDelta)">
              {{ deltaText(tokenDelta) }}
            </span>
          </div>
          <div class="sub">环比 {{ previousLabel }}</div>
          <BaseChart
            v-if="sparkValues.length > 1"
            class="spark"
            :option="sparklineOption(sparkValues, CHART_PALETTE[0])"
            :height="40"
          />
        </div>

        <div
          v-for="item in secondaryMetrics"
          :key="item.label"
          class="metric secondary"
          :class="{ clickable: !!item.path }"
          role="button"
          :tabindex="item.path ? 0 : -1"
          @click="go(item.path)"
          @keydown.enter.prevent="go(item.path)"
          @keydown.space.prevent="go(item.path)"
        >
          <div class="label">{{ item.label }}</div>
          <div class="value-row">
            <span class="value">{{ item.display }}</span>
            <span v-if="item.delta !== null" class="delta" :class="deltaClass(item.delta)">
              {{ deltaText(item.delta) }}
            </span>
          </div>
          <div class="sub">{{ item.sub }}</div>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" class="block-row">
      <el-col :xs="24" :md="12">
        <el-card v-loading="loading" class="block">
          <template #header>
            <div class="card-header">
              <span>运行态</span>
              <span class="card-hint">实时与窗口口径已分组</span>
            </div>
          </template>

          <div class="live-block">
            <div class="live-block-label">实时快照 · 不随统计周期变化</div>
            <div class="live-grid live-grid--2">
              <div
                v-for="item in liveRealtime"
                :key="item.label"
                class="live-item"
                :class="[item.tone, { clickable: !!item.path }]"
                role="button"
                :tabindex="item.path ? 0 : -1"
                @click="go(item.path)"
                @keydown.enter.prevent="go(item.path)"
                @keydown.space.prevent="go(item.path)"
              >
                <span class="live-label">{{ item.label }}</span>
                <span class="live-value">{{ formatNumber(item.value) }}</span>
              </div>
            </div>
          </div>

          <div class="live-block">
            <div class="live-block-label">窗口结果 · 随统计周期</div>
            <div class="live-grid live-grid--3">
              <div
                v-for="item in liveWindow"
                :key="item.label"
                class="live-item"
                :class="[item.tone, { clickable: !!item.path }]"
                role="button"
                :tabindex="item.path ? 0 : -1"
                @click="go(item.path)"
                @keydown.enter.prevent="go(item.path)"
                @keydown.space.prevent="go(item.path)"
              >
                <span class="live-label">{{ item.label }}</span>
                <span class="live-value">{{ formatNumber(item.value) }}</span>
              </div>
            </div>
          </div>

          <div class="live-actions">
            <el-button link type="primary" @click="go('/sessions?phase=FAILED')">查看失败会话</el-button>
            <el-button link type="primary" @click="go('/analytics?tab=sessions')">会话结构详情</el-button>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card v-loading="loading" class="block">
          <template #header>
            <div class="card-header">
              <span>窗口洞察</span>
              <span class="card-hint">基于本周期与环比汇总</span>
            </div>
          </template>
          <ul class="insights">
            <li v-for="(item, index) in insights" :key="index" :class="item.level">
              <button v-if="item.path" class="insight-link" type="button" @click="go(item.path)">
                {{ item.text }}
              </button>
              <span v-else>{{ item.text }}</span>
            </li>
            <li v-if="insights.length === 0" class="muted">窗口内暂无异常洞察</li>
          </ul>
          <div class="compose-grid">
            <div class="compose-title">窗口构成（非重复环比）</div>
            <div v-for="row in composeRows" :key="row.label" class="compose-row">
              <span class="label">{{ row.label }}</span>
              <span class="current" :class="{ fail: row.fail }">{{ row.valueText }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { formatCompact, formatTokens, sparklineOption } from '../chart-options'
import { delta, deltaClass, deltaText } from '../composables/metrics'
import type { OverviewPayload, PeriodTotals, PreviousTotals } from '../types'

const props = defineProps<{
  payload: OverviewPayload | null
  loading: boolean
  periodText: string
  previousText: string
}>()
const router = useRouter()

const EMPTY: PeriodTotals = {
  sessions: 0,
  messages: 0,
  chatTokens: 0,
  backgroundTokens: 0,
  totalTokens: 0,
  backgroundCalls: 0,
  activeUsers: 0,
  completedSessions: 0,
  failedSessions: 0
}

const totals = computed<PeriodTotals>(() => ({ ...EMPTY, ...(props.payload?.periodTotals || {}) }))
const previous = computed<PreviousTotals>(() => props.payload?.previousTotals || {})
const insights = computed(() => props.payload?.insights || [])
const totalTokens = computed(() => totals.value.totalTokens)
const sparkValues = computed(() => (props.payload?.spark || []).map((p) => p.totalTokens))
const previousLabel = computed(() => props.previousText || '上一周期')

const tokenDelta = computed(() => delta(totals.value.totalTokens, previous.value.totalTokens))

const secondaryMetrics = computed(() => [
  {
    label: '新增会话',
    display: formatCompact(totals.value.sessions),
    delta: delta(totals.value.sessions, previous.value.sessions),
    sub: `完成 ${formatNumber(totals.value.completedSessions)} · 失败 ${formatNumber(totals.value.failedSessions)}`,
    path: '/analytics?tab=sessions'
  },
  {
    label: '消息数',
    display: formatCompact(totals.value.messages),
    delta: delta(totals.value.messages, previous.value.messages),
    sub: `后台调用 ${formatNumber(totals.value.backgroundCalls)}`,
    path: '/analytics?tab=trends'
  },
  {
    label: '活跃用户',
    display: formatCompact(totals.value.activeUsers),
    delta: delta(totals.value.activeUsers, previous.value.activeUsers),
    sub: '窗口内有会话或消息',
    path: '/analytics?tab=users'
  }
])

type LiveItem = {
  label: string
  value: number
  tone: string
  path: string | undefined
}

const liveRealtime = computed<LiveItem[]>(() => {
  const overview = props.payload?.overview || {}
  const phase = props.payload?.phaseDistribution || []
  const live = (key: string) => Number(overview[key] ?? 0)
  const fromPhase = (name: string) => phase.find((p) => p.phase === name)?.count ?? 0
  return [
    {
      label: '运行中',
      value: overview['runningSessions'] != null ? live('runningSessions') : fromPhase('RUNNING'),
      tone: 'run',
      path: '/sessions?phase=RUNNING'
    },
    {
      label: '等待审批',
      value: overview['waitingSessions'] != null ? live('waitingSessions') : fromPhase('WAITING_APPROVAL'),
      tone: 'wait',
      path: '/sessions?phase=WAITING_APPROVAL'
    }
  ]
})

const liveWindow = computed<LiveItem[]>(() => {
  const phase = props.payload?.phaseDistribution || []
  const fromPhase = (name: string) => phase.find((p) => p.phase === name)?.count ?? 0
  return [
    {
      label: '已完成',
      value: totals.value.completedSessions || fromPhase('COMPLETED'),
      tone: 'done',
      path: '/analytics?tab=sessions'
    },
    { label: '失败', value: fromPhase('FAILED'), tone: 'fail', path: '/sessions?phase=FAILED' },
    { label: '已取消', value: fromPhase('CANCELLED'), tone: 'muted', path: undefined }
  ]
})

/** 构成明细：补充指标条之外的结构信息，避免与环比重复 */
const composeRows = computed(() => [
  { label: '对话 Token', valueText: formatTokens(totals.value.chatTokens), fail: false },
  { label: '后台 Token', valueText: formatTokens(totals.value.backgroundTokens), fail: false },
  { label: '完成会话', valueText: formatNumber(totals.value.completedSessions), fail: false },
  { label: '失败会话', valueText: formatNumber(totals.value.failedSessions), fail: true }
])

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

function go(path?: string) {
  if (path) router.push(path)
}
</script>

<script lang="ts">
export default {
  name: 'OverviewTab'
}
</script>

<style scoped>
.block,
.block-row {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.metric-strip {
  display: grid;
  grid-template-columns: minmax(220px, 1.4fr) repeat(3, minmax(140px, 1fr));
  gap: 8px;
  min-height: 120px;
}

.metric {
  padding: 8px 12px;
  border-left: 1px solid var(--mao-border);
}

.metric:first-child {
  border-left: none;
  padding-left: 0;
}

.metric.clickable {
  cursor: pointer;
}

.metric.clickable:hover .value {
  color: var(--mao-accent);
}

.metric.clickable:focus-visible {
  outline: 2px solid var(--mao-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.label {
  font-size: 13px;
  color: var(--mao-muted);
}

.value-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}

.value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--mao-ink);
  font-variant-numeric: tabular-nums;
}

.primary .value {
  font-size: 36px;
}

.delta {
  font-size: 12px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}

.delta.up {
  color: #c9252d;
  background: rgba(255, 59, 48, 0.1);
}

.delta.down {
  color: var(--mao-success);
  background: rgba(52, 199, 89, 0.12);
}

.delta.flat {
  color: var(--mao-muted);
  background: var(--mao-canvas);
}

.sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--mao-muted);
}

.spark {
  width: 100%;
  max-width: 240px;
  margin-top: 4px;
}

.live-block + .live-block {
  margin-top: 14px;
}

.live-block-label {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--mao-muted);
}

.live-grid {
  display: grid;
  gap: 12px;
}

.live-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.live-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.live-item {
  padding: 12px;
  background: var(--mao-canvas);
  border-radius: 8px;
}

.live-item.clickable {
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.live-item.clickable:hover {
  box-shadow: 0 0 0 1px var(--mao-accent);
}

.live-item.clickable:focus-visible {
  outline: 2px solid var(--mao-accent);
  outline-offset: 2px;
}

.live-label {
  display: block;
  font-size: 12px;
  color: var(--mao-muted);
}

.live-value {
  display: block;
  margin-top: 4px;
  font-size: 22px;
  font-weight: 700;
  color: var(--mao-ink);
  font-variant-numeric: tabular-nums;
}

.live-item.fail .live-value {
  color: var(--mao-danger);
}

.live-item.run .live-value {
  color: var(--mao-accent);
}

.live-item.wait .live-value {
  color: var(--mao-warn);
}

.live-item.done .live-value {
  color: var(--mao-success);
}

.live-actions {
  margin-top: 12px;
}

.insights {
  margin: 0;
  padding: 0;
  list-style: none;
}

.insights li {
  padding: 8px 0;
  border-bottom: 1px solid var(--mao-border);
  font-size: 13px;
  color: var(--mao-ink);
}

.insights li:last-child {
  border-bottom: none;
}

.insights li.warn {
  color: #c9252d;
}

.insights li.muted {
  color: var(--mao-muted);
}

.insight-link {
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.insight-link:hover {
  color: var(--mao-accent);
}

.insight-link:focus-visible {
  outline: 2px solid var(--mao-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.compose-grid {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--mao-border);
}

.compose-title {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--mao-muted);
}

.compose-row {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
}

.compose-row .label {
  color: var(--mao-muted);
}

.compose-row .current {
  text-align: right;
  font-weight: 600;
  color: var(--mao-ink);
  font-variant-numeric: tabular-nums;
}

.compose-row .current.fail {
  color: var(--mao-danger);
}

@media (max-width: 960px) {
  .metric-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metric {
    border-left: none;
    border-top: 1px solid var(--mao-border);
    padding: 12px 0;
  }

  .metric:first-child {
    border-top: none;
  }

  .live-grid--3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .live-grid--2,
  .live-grid--3 {
    grid-template-columns: 1fr;
  }

  .primary .value {
    font-size: 30px;
  }
}
</style>
