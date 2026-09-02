<template>
  <div class="analytics-view" v-loading="loading">
    <el-card class="toolbar-card">
      <div class="toolbar">
        <div class="toolbar-info">
          <div class="toolbar-title">用量分析</div>
          <div class="toolbar-hint">
            {{ periodText }}，环比对照 {{ previousText }}；数字均为窗口内新增。实时异常请用运行监控。
          </div>
        </div>
        <div class="toolbar-actions">
          <span class="toolbar-label">统计周期</span>
          <el-segmented v-model="days" :options="periodOptions" @change="fetchSummary" />
          <el-button :loading="loading" @click="fetchSummary">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" class="kpi-row">
      <el-col v-for="kpi in kpis" :key="kpi.label" :xs="12" :sm="12" :md="6">
        <el-card
          shadow="hover"
          :class="{ 'clickable-card': !!kpi.path }"
          :role="kpi.path ? 'button' : undefined"
          :tabindex="kpi.path ? 0 : undefined"
          @click="go(kpi.path)"
          @keydown.enter="go(kpi.path)"
          @keydown.space.prevent="go(kpi.path)"
        >
          <div class="kpi">
            <div class="kpi-head">
              <span class="kpi-label">{{ kpi.label }}</span>
              <span v-if="kpi.delta !== null" class="kpi-delta" :class="deltaClass(kpi.delta, kpi.inverse)">
                {{ deltaText(kpi.delta) }}
              </span>
            </div>
            <div class="kpi-value" :title="formatNumber(kpi.value)">
              {{ formatCompact(kpi.value) }}<span v-if="kpi.unit" class="kpi-unit">{{ kpi.unit }}</span>
            </div>
            <div class="kpi-foot">
              <span class="kpi-sub">{{ kpi.sub }}</span>
              <BaseChart
                v-if="kpi.series"
                class="kpi-spark"
                :option="sparklineOption(kpi.series, kpi.color)"
                :height="32"
              />
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="chart-row">
      <el-col :xs="24" :md="14">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>会话与消息趋势</span>
              <span class="card-hint">双轴：会话（左）/ 消息（右）</span>
            </div>
          </template>
          <BaseChart :option="trafficTrendOption(trends)" :empty="!hasTraffic" :height="300" />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="10">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>会话结局分布</span>
              <span class="card-hint">窗口内创建的会话</span>
            </div>
          </template>
          <BaseChart
            :option="donutOption(phaseItems, '会话总数', formatCompact(phaseTotal))"
            :empty="phaseItems.length === 0"
            :height="300"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="chart-row">
      <el-col :xs="24" :md="14">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>Token 消耗趋势</span>
              <span class="card-hint">对话消息 + 后台调用（标题生成、提交信息等）</span>
            </div>
          </template>
          <BaseChart :option="tokenTrendOption(trends)" :empty="!hasTokens" :height="300" />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="10">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>模型 Token 占比</span>
              <span class="card-hint">Top 10 + 其他</span>
            </div>
          </template>
          <BaseChart
            :option="donutOption(modelTokenItems, 'Token 总量', formatCompact(periodTotals.totalTokens))"
            :empty="modelTokenItems.length === 0"
            :height="300"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="chart-row">
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>Agent Token 排行</span>
              <el-button type="primary" link @click="go('/agents')">Agent 管理</el-button>
            </div>
          </template>
          <BaseChart
            :option="rankBarOption(agentTokenItems, CHART_PALETTE[0])"
            :empty="agentTokenItems.length === 0"
            :height="Math.max(200, agentTokenItems.length * 34 + 32)"
          />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>用户活跃排行</span>
              <span class="card-hint">按窗口内消息数</span>
            </div>
          </template>
          <BaseChart
            :option="rankBarOption(userMessageItems, CHART_PALETTE[1])"
            :empty="userMessageItems.length === 0"
            :height="Math.max(200, userMessageItems.length * 34 + 32)"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-card class="detail-card">
      <template #header>
        <div class="card-header">
          <span>模型用量明细</span>
          <el-button type="primary" link @click="go('/models')">模型管理</el-button>
        </div>
      </template>
      <el-table :data="modelStats" size="small" stripe>
        <template #empty>
          <el-empty description="窗口内暂无模型调用" :image-size="48" />
        </template>
        <el-table-column prop="modelName" label="模型" min-width="150" show-overflow-tooltip />
        <el-table-column prop="provider" label="供应商" width="120" class-name="hide-on-mobile" />
        <el-table-column label="会话" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.sessionCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="消息" width="90" align="right">
          <template #default="{ row }">{{ formatNumber(row.messageCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="对话 Token" width="120" align="right">
          <template #default="{ row }">{{ formatNumber(row.chatTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="后台 Token" width="120" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.backgroundTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="Token 合计" width="120" align="right">
          <template #default="{ row }">
            <strong>{{ formatNumber(row.totalTokens || 0) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="占比" min-width="140">
          <template #default="{ row }">
            <el-progress
              :percentage="tokenShare(row.totalTokens)"
              :stroke-width="8"
              :show-text="false"
              :color="CHART_PALETTE[0]"
            />
            <span class="share-text">{{ tokenShare(row.totalTokens) }}%</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'
import BaseChart from '../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../utils/echarts'
import {
  donutOption,
  formatCompact,
  formatNumber,
  phaseRankItems,
  rankBarOption,
  sparklineOption,
  tokenTrendOption,
  topWithOthers,
  trafficTrendOption,
  type RankItem,
  type TrendPoint
} from './chart-options'

interface PeriodTotals {
  sessions: number
  messages: number
  chatTokens: number
  backgroundTokens: number
  totalTokens: number
  backgroundCalls: number
  activeUsers: number
  completedSessions: number
  failedSessions: number
}

const EMPTY_TOTALS: PeriodTotals = {
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

const router = useRouter()
const days = ref(30)
const loading = ref(false)
const periodOptions = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 }
]
const summary = ref<Record<string, any>>({})

const trends = computed<TrendPoint[]>(() => (summary.value.trends || []) as TrendPoint[])
const periodTotals = computed<PeriodTotals>(() => ({ ...EMPTY_TOTALS, ...(summary.value.periodTotals || {}) }))
const previousTotals = computed<Record<string, number>>(() => summary.value.previousTotals || {})
const modelStats = computed<any[]>(() => summary.value.modelStats || [])

const hasTraffic = computed(() => trends.value.some((t) => t.sessions > 0 || t.messages > 0))
const hasTokens = computed(() => trends.value.some((t) => t.totalTokens > 0))

const periodText = computed(() => {
  const period = summary.value.period
  return period ? `${period.start} ~ ${period.end}（${period.days} 天）` : `近 ${days.value} 天`
})
const previousText = computed(() => {
  const period = summary.value.period
  return period ? `${period.previousStart} ~ ${period.previousEnd}` : '上一周期'
})

const phaseItems = computed<RankItem[]>(() => phaseRankItems(summary.value.phaseDistribution || []))
const phaseTotal = computed(() => phaseItems.value.reduce((sum, item) => sum + item.value, 0))

const modelTokenItems = computed<RankItem[]>(() =>
  topWithOthers(
    modelStats.value.map((row) => ({ name: row.modelName || '未命名', value: Number(row.totalTokens || 0) })),
    10
  )
)

const agentTokenItems = computed<RankItem[]>(() =>
  (summary.value.agentStats || [])
    .map((row: any) => ({ name: row.agentName || '未知', value: Number(row.totalTokens || 0) }))
    .filter((item: RankItem) => item.value > 0)
    .sort((a: RankItem, b: RankItem) => b.value - a.value)
    .slice(0, 8)
)

const userMessageItems = computed<RankItem[]>(() =>
  (summary.value.userActivity || [])
    .map((row: any) => ({ name: row.displayName || row.username || '未知', value: Number(row.messageCount || 0) }))
    .filter((item: RankItem) => item.value > 0)
    .sort((a: RankItem, b: RankItem) => b.value - a.value)
    .slice(0, 8)
)

const kpis = computed(() => {
  const totals = periodTotals.value
  const previous = previousTotals.value
  const successBase = totals.completedSessions + totals.failedSessions
  return [
    {
      label: '新增会话',
      value: totals.sessions,
      unit: '',
      delta: delta(totals.sessions, previous.sessions),
      sub: `活跃用户 ${formatNumber(totals.activeUsers)}`,
      series: trends.value.map((t) => t.sessions),
      color: CHART_PALETTE[0],
      inverse: false,
      path: '/sessions'
    },
    {
      label: '消息数',
      value: totals.messages,
      unit: '',
      delta: delta(totals.messages, previous.messages),
      sub: `日均 ${formatCompact(Math.round(totals.messages / Math.max(1, trends.value.length)))}`,
      series: trends.value.map((t) => t.messages),
      color: CHART_PALETTE[1],
      inverse: false,
      path: ''
    },
    {
      label: 'Token 消耗',
      value: totals.totalTokens,
      unit: '',
      delta: delta(totals.totalTokens, previous.totalTokens),
      sub: `后台占 ${percent(totals.backgroundTokens, totals.totalTokens)}%`,
      series: trends.value.map((t) => t.totalTokens),
      color: CHART_PALETTE[2],
      inverse: true,
      path: ''
    },
    {
      label: '会话失败率',
      value: successBase > 0 ? Math.round((totals.failedSessions / successBase) * 100) : 0,
      unit: '%',
      delta: null,
      sub: `失败 ${formatNumber(totals.failedSessions)} / 完成 ${formatNumber(totals.completedSessions)}`,
      series: null,
      color: '#ff3b30',
      inverse: true,
      path: '/runtime?phase=FAILED'
    }
  ]
})

/** 上一周期为 0 时无法算环比，返回 null 让 UI 不展示。 */
function delta(current: number, previous: number | undefined): number | null {
  if (previous == null || previous === 0) return current > 0 ? null : 0
  return Math.round(((current - previous) / previous) * 100)
}

function deltaText(value: number | null): string {
  if (value === null) return ''
  if (value === 0) return '持平'
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}%`
}

function deltaClass(value: number | null, inverse: boolean) {
  if (value === null || value === 0) return 'flat'
  const good = inverse ? value < 0 : value > 0
  return good ? 'up' : 'down'
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

function tokenShare(value: unknown): number {
  return percent(Number(value || 0), periodTotals.value.totalTokens)
}

function go(path: string) {
  if (path) router.push(path)
}

let fetchSummarySeq = 0
async function fetchSummary() {
  const seq = ++fetchSummarySeq
  loading.value = true
  try {
    const { data } = await api.get('/admin/analytics/summary', { params: { days: days.value } })
    if (seq !== fetchSummarySeq) return
    summary.value = data || {}
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchSummarySeq) loading.value = false
  }
}

onMounted(fetchSummary)
</script>

<style scoped>
.toolbar-card,
.kpi-row {
  margin-bottom: 16px;
}

.chart-row,
.detail-card {
  margin-bottom: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.toolbar-hint {
  margin-top: 4px;
  font-size: 13px;
  color: var(--mao-muted);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.clickable-card {
  cursor: pointer;
}

.kpi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kpi-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.kpi-delta {
  font-size: 12px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
}

.kpi-delta.up {
  color: #1a7f37;
  background: rgba(52, 199, 89, 0.12);
}

.kpi-delta.down {
  color: #c9252d;
  background: rgba(255, 59, 48, 0.1);
}

.kpi-delta.flat {
  color: var(--mao-muted);
  background: var(--mao-canvas);
}

.kpi-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--mao-ink);
}

.kpi-unit {
  margin-left: 2px;
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-muted);
}

.kpi-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.kpi-sub {
  font-size: 12px;
  color: var(--mao-muted);
  white-space: nowrap;
}

.kpi-spark {
  width: 84px;
  flex-shrink: 0;
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

.share-text {
  margin-left: 8px;
  font-size: 12px;
  color: var(--mao-muted);
}

@media (max-width: 768px) {
  .analytics-view :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .analytics-view :deep(.el-col) {
    max-width: 100%;
    flex: 0 0 100%;
    margin-bottom: 16px;
  }

  .kpi-row :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }

  .toolbar {
    flex-wrap: wrap;
  }

  .toolbar-actions {
    width: 100%;
  }

  .kpi-spark {
    display: none;
  }

  .detail-card :deep(.el-table) {
    overflow-x: auto;
  }
}
</style>
