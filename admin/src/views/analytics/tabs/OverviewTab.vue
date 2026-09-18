<template>
  <div class="overview-tab">
    <el-card class="block">
      <div class="metric-strip" v-loading="loading">
        <div class="metric primary">
          <div class="label">Token 消耗</div>
          <div class="value-row">
            <span class="value">{{ formatCompact(totalTokens) }}</span>
            <span v-if="tokenDelta !== null" class="delta" :class="deltaClass(tokenDelta, true)">
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
          tabindex="0"
          @click="go(item.path)"
          @keydown.enter="go(item.path)"
        >
          <div class="label">{{ item.label }}</div>
          <div class="value-row">
            <span class="value">{{ item.display }}</span>
            <span v-if="item.delta !== null" class="delta" :class="deltaClass(item.delta, item.inverse)">
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
              <span class="card-hint">实时快照，不随统计周期变化</span>
            </div>
          </template>
          <div class="live-grid">
            <div v-for="item in liveItems" :key="item.label" class="live-item" :class="item.tone">
              <span class="live-label">{{ item.label }}</span>
              <span class="live-value">{{ formatNumber(item.value) }}</span>
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
          </ul>
          <div class="compare-grid">
            <div v-for="row in compareRows" :key="row.label" class="compare-row">
              <span class="label">{{ row.label }}</span>
              <span class="current">{{ formatNumber(row.current) }}</span>
              <span class="delta" :class="deltaClass(row.delta, row.inverse)">
                {{ deltaText(row.delta) }}
              </span>
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
import { formatCompact, sparklineOption } from '../chart-options'
import { delta, deltaClass, deltaText } from '../composables/metrics'
import type { OverviewPayload, PeriodTotals, PreviousTotals } from '../types'

const props = defineProps<{
  payload: OverviewPayload | null
  loading: boolean
  error: boolean
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
    inverse: false,
    sub: `活跃用户 ${formatNumber(totals.value.activeUsers)}`,
    path: '/analytics?tab=trends'
  },
  {
    label: '消息数',
    display: formatCompact(totals.value.messages),
    delta: delta(totals.value.messages, previous.value.messages),
    inverse: false,
    sub: `失败会话 ${formatNumber(totals.value.failedSessions)}`,
    path: '/analytics?tab=sessions'
  },
  {
    label: '活跃用户',
    display: formatCompact(totals.value.activeUsers),
    delta: delta(totals.value.activeUsers, previous.value.activeUsers),
    inverse: false,
    sub: '窗口内有会话或消息',
    path: '/analytics?tab=users'
  }
])

const liveItems = computed(() => {
  const overview = props.payload?.overview || {}
  const phase = props.payload?.phaseDistribution || []
  const live = (key: string) => Number(overview[key] ?? 0)
  const fromPhase = (name: string) => phase.find((p) => p.phase === name)?.count ?? 0
  return [
    { label: '运行中', value: live('runningSessions') || fromPhase('RUNNING'), tone: 'run' },
    { label: '等待审批', value: live('waitingSessions') || fromPhase('WAITING_APPROVAL'), tone: 'wait' },
    { label: '失败（窗口）', value: fromPhase('FAILED'), tone: 'fail' },
    { label: '已取消（窗口）', value: fromPhase('CANCELLED'), tone: 'muted' }
  ]
})

const compareRows = computed(() => [
  {
    label: '会话',
    current: totals.value.sessions,
    delta: delta(totals.value.sessions, previous.value.sessions),
    inverse: false
  },
  {
    label: '消息',
    current: totals.value.messages,
    delta: delta(totals.value.messages, previous.value.messages),
    inverse: false
  },
  {
    label: 'Token',
    current: totals.value.totalTokens,
    delta: delta(totals.value.totalTokens, previous.value.totalTokens),
    inverse: true
  },
  {
    label: '活跃用户',
    current: totals.value.activeUsers,
    delta: delta(totals.value.activeUsers, previous.value.activeUsers),
    inverse: false
  }
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
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--mao-ink);
}

.primary .value {
  font-size: 32px;
}

.delta {
  font-size: 12px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
}

.delta.good {
  color: #1a7f37;
  background: rgba(52, 199, 89, 0.12);
}

.delta.bad {
  color: #c9252d;
  background: rgba(255, 59, 48, 0.1);
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

.live-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.live-item {
  padding: 12px;
  background: var(--mao-canvas);
  border-radius: 8px;
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
}

.live-item.fail .live-value {
  color: #ff3b30;
}

.live-item.run .live-value {
  color: #0066cc;
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

.compare-grid {
  margin-top: 8px;
}

.compare-row {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
}

.compare-row .label {
  color: var(--mao-muted);
}

.compare-row .current {
  font-weight: 600;
  color: var(--mao-ink);
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
}
</style>
