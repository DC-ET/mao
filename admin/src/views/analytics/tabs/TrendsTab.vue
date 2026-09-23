<template>
  <div class="trends-tab">
    <div class="grain-bar">
      <span class="grain-label">时间粒度</span>
      <el-segmented
        :model-value="grain"
        :options="GRAIN_OPTIONS"
        @update:model-value="emit('update:grain', $event as TrendGrain)"
      />
    </div>
    <div class="chart-grid">
      <el-card class="block span-2">
        <template #header>
          <div class="card-header">
            <span class="chart-title">流量</span>
            <span class="card-hint">会话与消息分图展示，避免双轴误读</span>
          </div>
        </template>
        <el-row :gutter="16">
          <el-col :xs="24" :md="12">
            <div class="mini-title">会话</div>
            <BaseChart :option="sessionTrendOption" :empty="!hasTraffic" :height="260" />
          </el-col>
          <el-col :xs="24" :md="12">
            <div class="mini-title">消息</div>
            <BaseChart :option="messageTrendOption" :empty="!hasTraffic" :height="260" />
          </el-col>
        </el-row>
      </el-card>

      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">Token</span>
            <span class="card-hint">对话 Token + 后台调用 Token</span>
          </div>
        </template>
        <BaseChart :option="tokenTrendChartOption" :empty="!hasTokens" :height="260" />
      </el-card>

      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">调用</span>
            <span class="card-hint">次数与失败次数，默认排除连通性测试</span>
          </div>
        </template>
        <BaseChart :option="callTrendChartOption" :empty="!hasCalls" :height="260" />
      </el-card>

      <el-card class="block span-2">
        <template #header>
          <div class="card-header">
            <span class="chart-title">质量</span>
            <span class="card-hint">成功率与缓存命中率（百分比轴）</span>
          </div>
        </template>
        <BaseChart :option="qualityTrendChartOption" :empty="!hasQuality" :height="260" />
      </el-card>
    </div>

    <el-card v-if="qualitySummary" class="block">
      <template #header>
        <div class="card-header">
          <span>窗口调用质量</span>
          <span class="card-hint">来自 llm_call 聚合</span>
        </div>
      </template>
      <div class="quality-strip">
        <div class="q-item">
          <span class="label">调用次数</span>
          <span class="value">{{ formatNumber(qualitySummary.callCount || 0) }}</span>
        </div>
        <div class="q-item">
          <span class="label">失败次数</span>
          <span class="value">{{ formatNumber(qualitySummary.failCount || 0) }}</span>
        </div>
        <div class="q-item">
          <span class="label">成功率</span>
          <span class="value">{{ rateText(qualitySummary.successRate) }}</span>
        </div>
        <div class="q-item">
          <span class="label">缓存命中率</span>
          <span class="value">{{ rateText(qualitySummary.cacheHitRate) }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import {
  formatNumber,
  isHourlyTrendDate,
  seriesTrendOption,
  tokenTrendOption,
  trendCategoryLabels,
  trendDataZoom,
  type TrendPoint
} from '../chart-options'
import type { TrendGrain } from '../composables/useAnalyticsPeriod'
import type { TrendsPayload } from '../types'

const GRAIN_OPTIONS = [
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' }
] as const

const props = defineProps<{
  payload: TrendsPayload | null
  loading?: boolean
  grain?: TrendGrain
}>()

const emit = defineEmits<{ (e: 'update:grain', value: TrendGrain): void }>()

const grain = computed<TrendGrain>(() => props.grain ?? 'day')

const trends = computed<TrendPoint[]>(() => props.payload?.trends || [])
const qualitySummary = computed(() => props.payload?.callQuality)
const hasTraffic = computed(() => trends.value.some((t) => t.sessions > 0 || t.messages > 0))
const hasTokens = computed(() => trends.value.some((t) => t.totalTokens > 0))
const hasCalls = computed(() => trends.value.some((t) => (t.callCount || 0) > 0 || (t.callFailCount || 0) > 0))
const hasQuality = computed(() =>
  trends.value.some((t) => t.callSuccessRate != null || t.cacheHitRate != null)
)

const sessionTrendOption = computed(() =>
  seriesTrendOption(trends.value, [{ key: 'sessions', name: '会话', color: CHART_PALETTE[0] }])
)
const messageTrendOption = computed(() =>
  seriesTrendOption(trends.value, [{ key: 'messages', name: '消息', color: CHART_PALETTE[1] }])
)
const tokenTrendChartOption = computed(() => tokenTrendOption(trends.value))

const callTrendChartOption = computed(() => {
  const dates = trends.value.map((t) => t.date)
  const hourly = dates.some(isHourlyTrendDate)
  const zoom = trendDataZoom(trends.value.length, hourly)
  return {
    color: [CHART_PALETTE[0], CHART_PALETTE[5]],
    tooltip: { trigger: 'axis' as const },
    legend: { top: 0, left: 'center' as const },
    grid: { left: 8, right: 8, top: 32, bottom: zoom ? 28 : 4, containLabel: true },
    dataZoom: zoom,
    xAxis: {
      type: 'category' as const,
      data: trendCategoryLabels(dates),
      axisTick: { show: false },
      axisLabel: { color: AXIS_MUTED, fontSize: 11, hideOverlap: true }
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { color: AXIS_MUTED, fontSize: 11 },
      splitLine: { lineStyle: { color: SPLIT_MUTED } }
    },
    series: [
      {
        name: '调用次数',
        type: 'bar' as const,
        barMaxWidth: 22,
        data: trends.value.map((t) => t.callCount || 0)
      },
      {
        name: '失败次数',
        type: 'line' as const,
        smooth: true,
        symbolSize: 6,
        data: trends.value.map((t) => t.callFailCount || 0)
      }
    ]
  }
})

const qualityTrendChartOption = computed(() => {
  const dates = trends.value.map((t) => t.date)
  const hourly = dates.some(isHourlyTrendDate)
  const zoom = trendDataZoom(trends.value.length, hourly)
  return {
    color: [CHART_PALETTE[1], CHART_PALETTE[4]],
    tooltip: { trigger: 'axis' as const },
    legend: { top: 0, left: 'center' as const },
    grid: { left: 8, right: 8, top: 32, bottom: zoom ? 28 : 4, containLabel: true },
    dataZoom: zoom,
    xAxis: {
      type: 'category' as const,
      data: trendCategoryLabels(dates),
      boundaryGap: false,
      axisTick: { show: false },
      axisLabel: { color: AXIS_MUTED, fontSize: 11, hideOverlap: true }
    },
    yAxis: {
      type: 'value' as const,
      max: 100,
      axisLabel: { color: AXIS_MUTED, fontSize: 11, formatter: '{value}%' },
      splitLine: { lineStyle: { color: SPLIT_MUTED } }
    },
    series: [
      {
        name: '成功率%',
        type: 'line' as const,
        smooth: true,
        connectNulls: true,
        data: trends.value.map((t) => t.callSuccessRate)
      },
      {
        name: '缓存命中率%',
        type: 'line' as const,
        smooth: true,
        connectNulls: true,
        data: trends.value.map((t) => t.cacheHitRate)
      }
    ]
  }
})

const AXIS_MUTED = '#6e6e73'
const SPLIT_MUTED = 'rgba(0, 0, 0, 0.06)'

function rateText(value: unknown): string {
  return value == null ? '-' : `${value}%`
}
</script>

<script lang="ts">
export default { name: 'TrendsTab' }
</script>

<style scoped>
.grain-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-bottom: 12px;
}

.grain-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.chart-grid > .span-2 {
  grid-column: 1 / -1;
}

.block {
  margin-bottom: 0;
}

.chart-grid + .block {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.chart-title {
  font-weight: 600;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
  margin-bottom: 0;
}

.mini-title {
  font-size: 13px;
  color: var(--mao-muted);
  margin-bottom: 4px;
}

.quality-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.q-item {
  padding: 10px 12px;
  background: var(--mao-canvas);
  border-radius: 8px;
}

.q-item .label {
  display: block;
  font-size: 12px;
  color: var(--mao-muted);
}

.q-item .value {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--mao-ink);
}

@media (max-width: 768px) {
  .chart-grid {
    grid-template-columns: 1fr;
  }

  .quality-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
