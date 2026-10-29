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
      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">流量</span>
            <span class="card-hint">会话（左轴）与消息（右轴，虚线），量级差大时双轴各自缩放</span>
          </div>
        </template>
        <BaseChart :option="trafficTrendChartOption" :empty="!hasTraffic" :height="260" />
      </el-card>

      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">Token 与调用</span>
            <span class="card-hint">对话 / 后台 Token（左轴，堆叠）与调用次数、失败次数（右轴，虚线）</span>
          </div>
        </template>
        <BaseChart :option="tokenCallTrendChartOption" :empty="!hasTokens && !hasCalls" :height="260" />
      </el-card>

      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">质量</span>
            <span class="card-hint">成功率、缓存命中率（左轴 %）与平均耗时（右轴 ms，虚线）</span>
          </div>
        </template>
        <BaseChart :option="qualityTrendChartOption" :empty="!hasQuality" :height="260" />
      </el-card>

      <el-card class="block">
        <template #header>
          <div class="card-header">
            <span class="chart-title">成本</span>
            <span class="card-hint">桶内合计与每百万 Token 平均成本（llm_call 口径）</span>
          </div>
        </template>
        <BaseChart :option="costTrendChartOption" :empty="!hasCost" :height="260" />
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
          <span class="label">取消次数</span>
          <span class="value">{{ formatNumber(qualitySummary.cancelledCount || 0) }}</span>
        </div>
        <div class="q-item">
          <span class="label">成功率</span>
          <span class="value">{{ rateText(qualitySummary.successRate) }}</span>
        </div>
        <div class="q-item">
          <span class="label">缓存命中率</span>
          <span class="value">{{ rateText(qualitySummary.cacheHitRate) }}</span>
        </div>
        <div class="q-item">
          <span class="label">成本合计</span>
          <span class="value">{{ formatCost(qualitySummary.cost) }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseChart from '../../../components/BaseChart.vue'
import {
  costTrendOption,
  formatNumber,
  formatCost,
  qualityTrendOption,
  tokenCallTrendOption,
  trafficTrendOption,
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
  trends.value.some(
    (t) =>
      t.callSuccessRate != null ||
      t.cacheHitRate != null ||
      t.avgDurationMs != null ||
      t.avgFirstTokenMs != null
  )
)

const trafficTrendChartOption = computed(() => trafficTrendOption(trends.value))
const tokenCallTrendChartOption = computed(() => tokenCallTrendOption(trends.value))
const hasCost = computed(() => trends.value.some((t) => (t.cost || 0) > 0))
const costTrendChartOption = computed(() => costTrendOption(trends.value))

const qualityTrendChartOption = computed(() => qualityTrendOption(trends.value))

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
