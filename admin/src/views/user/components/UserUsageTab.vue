<template>
  <div class="user-usage">
    <div class="usage-toolbar">
      <el-select v-model="range" size="small" class="range-select" @change="handleRangeChange">
        <el-option-group
          v-for="group in PERIOD_GROUPS"
          :key="group.label"
          :label="group.label"
        >
          <el-option v-for="opt in group.options" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-option-group>
        <el-option label="自定义" value="custom" />
      </el-select>
      <template v-if="range === 'custom'">
        <el-date-picker
          v-model="customStart"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :disabled-date="disabledDate"
          placeholder="开始日期"
          @change="handleCustomChange('start')"
        />
        <span class="range-sep">~</span>
        <el-date-picker
          v-model="customEnd"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :disabled-date="disabledDate"
          placeholder="结束日期"
          @change="handleCustomChange('end')"
        />
      </template>
      <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
    </div>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="usage-error">
      <el-button link type="primary" @click="reload">重试</el-button>
    </el-alert>

    <div v-else v-loading="loading" class="usage-body">
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-label">总 Token</div>
          <div class="stat-value">{{ formatNumber(totals.totalTokens) }}</div>
          <div class="stat-sub">输入 {{ formatNumber(totals.promptTokens) }} · 输出 {{ formatNumber(totals.completionTokens) }} · 缓存 {{ formatNumber(totals.cachedTokens) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">
            总成本
            <el-tooltip content="成本 = 模型价格填写口径；未配价模型不计入，实际消耗可能高于此值" placement="top">
              <el-icon class="stat-info"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="stat-value">{{ formatCost(totals.cost) }}</div>
          <div class="stat-sub">未配价模型不计入</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">调用次数</div>
          <div class="stat-value">{{ formatNumber(totals.callCount) }}</div>
          <div class="stat-sub">成功 {{ formatNumber(totals.successCount) }} · 失败 {{ formatNumber(totals.failCount) }} · 取消 {{ formatNumber(totals.cancelledCount) }}<template v-if="successRate">（成功率 {{ successRate }}）</template></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">平均解码速度</div>
          <div class="stat-value">{{ throughput }}</div>
          <div class="stat-sub">流式输出 tokens/s（可解码口径）</div>
        </div>
      </div>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-header">
            <span class="block-title">趋势（{{ granularity === 'hour' ? '按小时' : '按天' }}）</span>
            <span class="block-hint">Token（左轴）与调用次数（右轴，虚线）</span>
          </div>
        </template>
        <BaseChart :option="trendOption" :empty="!hasCalls" empty-text="该周期内无 LLM 调用" :height="240" />
      </el-card>

      <el-row :gutter="12" class="dist-row">
        <el-col :xs="24" :md="8">
          <el-card shadow="never" class="block">
            <template #header><div class="card-header"><span class="block-title">按模型</span></div></template>
            <el-table :data="summary?.byModel || []" size="small" :show-header="true" empty-text="无调用">
              <el-table-column label="模型" min-width="110" show-overflow-tooltip>
                <template #default="{ row }">{{ row.modelName || '未知模型' }}</template>
              </el-table-column>
              <el-table-column label="Token" width="90" align="right">
                <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
              </el-table-column>
              <el-table-column label="调用" width="70" align="right">
                <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
              </el-table-column>
              <el-table-column label="成本" width="80" align="right">
                <template #default="{ row }">{{ formatCost(row.cost) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8">
          <el-card shadow="never" class="block">
            <template #header><div class="card-header"><span class="block-title">按场景</span></div></template>
            <el-table :data="summary?.byScene || []" size="small" empty-text="无调用">
              <el-table-column label="场景" min-width="120" show-overflow-tooltip>
                <template #default="{ row }">{{ llmCallSceneLabel(row.scene) }}</template>
              </el-table-column>
              <el-table-column label="Token" width="90" align="right">
                <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
              </el-table-column>
              <el-table-column label="调用" width="70" align="right">
                <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8">
          <el-card shadow="never" class="block">
            <template #header><div class="card-header"><span class="block-title">按 Agent</span></div></template>
            <el-table :data="summary?.byAgent || []" size="small" empty-text="无调用">
              <el-table-column label="Agent" min-width="120" show-overflow-tooltip>
                <template #default="{ row }">{{ agentLabel(row) }}</template>
              </el-table-column>
              <el-table-column label="Token" width="90" align="right">
                <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
              </el-table-column>
              <el-table-column label="调用" width="70" align="right">
                <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <div class="deep-links">
        <el-button v-if="canViewCalls" type="primary" link size="small" @click="goLlmCalls">查看调用流水</el-button>
        <el-button v-if="canViewSessions" link size="small" @click="goSessions">查看会话</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { InfoFilled } from '@element-plus/icons-vue'
import type { MyUsageSummary, MyUsageTrends, UsageRange } from '@mao/contracts'
import { api } from '../../../api'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE, type ChartOption } from '../../../utils/echarts'
import { llmCallSceneLabel } from '../../../utils/llmCallLabels'
import { useAuthStore } from '../../../stores/auth'
import {
  AXIS_LABEL_COLOR,
  SPLIT_LINE_COLOR,
  formatCompact,
  formatCost,
  formatNumber,
  trendDataZoom,
  trendLegend,
} from '../../analytics/chart-options'

/** 深链出口按钮按目标页路由权限二次门控（方案 §5.6），避免「Tab 可见、点出 403」。 */
const canViewCalls = computed(() => authStore.hasPermission('llm-call:read'))
const canViewSessions = computed(() => authStore.hasPermission('session:read'))

const props = defineProps<{ userId: number }>()

const authStore = useAuthStore()
const router = useRouter()

/** 周期分组文案与桌面「我的用量」usage-range 同源（日历周期在前、滚动窗口在后、自定义收尾）。 */
const PERIOD_GROUPS: Array<{ label: string; options: Array<{ label: string; value: UsageRange }> }> = [
  {
    label: '日历周期',
    options: [
      { label: '今日', value: 'today' },
      { label: '昨日', value: 'yesterday' },
      { label: '本周', value: 'week' },
      { label: '上周', value: 'lastWeek' },
      { label: '本月', value: 'month' },
      { label: '上月', value: 'lastMonth' },
    ],
  },
  {
    label: '最近',
    options: [
      { label: '近 7 天', value: 'last7' },
      { label: '近 30 天', value: 'last30' },
    ],
  },
]

const MAX_CUSTOM_SPAN_DAYS = 365

const range = ref<UsageRange>('last30')
const customStart = ref('')
const customEnd = ref('')
const summary = ref<MyUsageSummary | null>(null)
const trends = ref<MyUsageTrends | null>(null)
const loading = ref(false)
const error = ref('')

const totals = computed(() => summary.value?.totals ?? {
  callCount: 0, successCount: 0, failCount: 0, cancelledCount: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0,
})

const granularity = computed<'day' | 'hour'>(() => (range.value === 'today' || range.value === 'yesterday' ? 'hour' : 'day'))

const hasCalls = computed(() => (totals.value.callCount ?? 0) > 0)

const successRate = computed(() => {
  const denominator = totals.value.successCount + totals.value.failCount
  if (denominator <= 0) return ''
  return `${Math.round((totals.value.successCount / denominator) * 100)}%`
})

const throughput = computed(() => {
  if (totals.value.decodeMs <= 0) return '-'
  return `${(totals.value.decodeTokens / (totals.value.decodeMs / 1000)).toFixed(1)} tokens/s`
})

function agentLabel(row: { agentId: number | null; agentName: string | null }): string {
  if (row.agentId == null) return '系统调用（压缩 / 标题等）'
  return row.agentName || '已删除'
}

/** 趋势双轴：Token 左轴、调用次数右轴虚线；复用 analytics 的轴色 / 图例 / dataZoom helper。 */
const trendOption = computed<ChartOption>(() => {
  const buckets = trends.value?.buckets ?? []
  const hourly = granularity.value === 'hour'
  const dataZoom = trendDataZoom(buckets.length, hourly)
  return {
    grid: { left: 8, right: 8, top: 36, bottom: dataZoom ? 32 : 12, containLabel: true },
    tooltip: { trigger: 'axis' },
    legend: { ...trendLegend, data: ['Token', '调用次数'] },
    ...(dataZoom ? { dataZoom } : {}),
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.bucket),
      axisLabel: { color: AXIS_LABEL_COLOR(), formatter: (v: string) => (hourly ? v.slice(11, 16) : v.slice(5)) },
    },
    yAxis: [
      {
        type: 'value', name: 'Token',
        axisLabel: { color: AXIS_LABEL_COLOR(), formatter: (v: number) => formatCompact(v) },
        splitLine: { lineStyle: { color: SPLIT_LINE_COLOR() } },
      },
      {
        type: 'value', name: '调用',
        axisLabel: { color: AXIS_LABEL_COLOR() },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Token', type: 'line', smooth: true, showSymbol: buckets.length <= 31,
        itemStyle: { color: CHART_PALETTE[0] }, lineStyle: { color: CHART_PALETTE[0] },
        data: buckets.map((b) => b.totalTokens),
      },
      {
        name: '调用次数', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: buckets.length <= 31,
        itemStyle: { color: CHART_PALETTE[1] }, lineStyle: { color: CHART_PALETTE[1], type: 'dashed' },
        data: buckets.map((b) => b.callCount),
      },
    ],
  }
})

function queryParams(): Record<string, string> {
  const params: Record<string, string> = { range: range.value }
  if (range.value === 'custom' && customStart.value && customEnd.value) {
    params.startDate = customStart.value
    params.endDate = customEnd.value
  }
  return params
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 方案 §5.8：请求失败只走 Tab 内错误条 + 重试，不弹全局消息 → skipErrorToast
    const [summaryRes, trendsRes] = await Promise.all([
      api.get(`/admin/users/${props.userId}/usage/summary`, { params: queryParams(), skipErrorToast: true }),
      api.get(`/admin/users/${props.userId}/usage/trends`, { params: { ...queryParams(), granularity: granularity.value }, skipErrorToast: true }),
    ])
    summary.value = summaryRes.data ?? null
    trends.value = trendsRes.data ?? null
  } catch (e: any) {
    error.value = e?.response?.data?.message || e?.message || '用量数据加载失败'
  } finally {
    loading.value = false
  }
}

function reload() {
  void load()
}

/** 切到自定义且还没选日期时，先落默认区间（近 7 天，口径同桌面 defaultCustomDateRange）再请求，避免空日期打到后端兜底窗口。 */
function handleRangeChange(): void {
  if (range.value === 'custom' && (!customStart.value || !customEnd.value)) {
    const today = shanghaiTodayYmd()
    customStart.value = shiftYmd(today, -6)
    customEnd.value = today
  }
  reload()
}

/** 北京时间今天（YYYY-MM-DD）：统计窗口均为 Asia/Shanghai 日历口径，浏览器时区不能把默认区间算偏一天。 */
function shanghaiTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

// ---- 自定义区间：上限 365 天（方案 D4，对齐桌面回溯口径）；超限保留终点拉起点，两端禁用规则互相对应 ----

/** 上海日历日 → 本地零点 Date（el-date-picker disabledDate 的比较基准，禁用规则按同一把尺子比）。 */
function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function disabledDate(date: Date): boolean {
  const time = date.getTime()
  // 上界用上海口径的「今天」（组件其余上海时区口径同源），本地时区落后时不能把上海今天禁选
  const todayLocal = ymdToLocalDate(shanghaiTodayYmd())
  const min = todayLocal.getTime() - (MAX_CUSTOM_SPAN_DAYS - 1) * 86_400_000
  return time < min || time > todayLocal.getTime()
}

function handleCustomChange(side: 'start' | 'end'): void {
  if (!customStart.value || !customEnd.value) return
  if (customStart.value > customEnd.value) {
    const s = customStart.value
    customStart.value = customEnd.value
    customEnd.value = s
  }
  const span = Math.round((Date.parse(customEnd.value) - Date.parse(customStart.value)) / 86_400_000) + 1
  if (span > MAX_CUSTOM_SPAN_DAYS) {
    if (side === 'start') customEnd.value = shiftYmd(customStart.value, MAX_CUSTOM_SPAN_DAYS - 1)
    else customStart.value = shiftYmd(customEnd.value, -(MAX_CUSTOM_SPAN_DAYS - 1))
  }
  reload()
}

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

// ---- 深链出口：周期窗口日期由后端随 summary 下发（window 字段），前端不复刻时区换算 ----

function goLlmCalls() {
  if (!summary.value) return
  router.push({
    path: '/llm-calls',
    query: {
      userId: String(props.userId),
      startDate: summary.value.window.startYmd,
      endDate: summary.value.window.endYmd,
    },
  })
}

function goSessions() {
  router.push({ path: '/sessions', query: { userId: String(props.userId) } })
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.user-usage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.usage-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.range-select {
  width: 130px;
}

.range-sep {
  color: var(--mao-muted);
}

.usage-error {
  margin: 4px 0;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.stat-card {
  border: 1px solid var(--mao-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--mao-surface, #fff);
}

.stat-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--mao-muted);
}

.stat-info {
  font-size: 13px;
  cursor: help;
}

.stat-value {
  font-size: 22px;
  font-weight: 600;
  margin: 4px 0;
  font-variant-numeric: tabular-nums;
}

.stat-sub {
  font-size: 12px;
  color: var(--mao-muted);
}

.block {
  border-radius: 8px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.block-title {
  font-weight: 600;
}

.block-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.dist-row :deep(.el-card__body) {
  padding: 8px 12px;
}

.deep-links {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
</style>
