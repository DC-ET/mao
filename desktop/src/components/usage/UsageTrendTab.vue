<template>
  <div class="usage-trend" v-loading="loading">
    <BaseChart :option="chartOption" :empty="!hasData" :height="300" />
    <div v-if="hasData" class="trend-summary">
      <span>窗口调用 {{ formatNumber(series.totalCalls) }} 次</span>
      <span>Token {{ formatNumber(series.totalTokens) }}</span>
      <span>成本 {{ formatCost(series.totalCost) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useTheme } from '../../utils/theme'
import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'
import { fetchMyUsageTrends, type UsageTrendBucket } from '../../api'
import { formatCost, formatNumber } from '../../utils/usageFormat'
import { buildTrendSeries } from './trend-series'
import BaseChart from '../common/BaseChart.vue'

const props = defineProps<{
  days: number
  /** 抽屉「刷新」按钮令牌：变化即重拉，不 remount（保留图表实例） */
  refreshKey?: number
}>()

const { isDark } = useTheme()
const buckets = ref<UsageTrendBucket[]>([])
const loading = ref(false)

let fetchSeq = 0
async function fetchTrends() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const data = await fetchMyUsageTrends(props.days)
    if (seq !== fetchSeq) return
    buckets.value = data?.buckets || []
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

onMounted(fetchTrends)
watch(() => props.days, fetchTrends)
watch(() => props.refreshKey, fetchTrends)

const series = computed(() => buildTrendSeries(buckets.value))
const hasData = computed(() => series.value.totalCalls > 0)

/** 主题随 isDark 重算：坐标文字/网格线/tooltip 底色两套配色，避免暗色下糊成一团。 */
const chartOption = computed<ChartOption>(() => {
  const axisColor = isDark.value ? '#a1a1a6' : '#86868b'
  const splitLine = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  const tooltipBg = isDark.value ? '#2a2a2e' : '#ffffff'
  const tooltipBorder = isDark.value ? '#3a3a3e' : '#e5e5ea'
  const tooltipText = isDark.value ? '#f5f5f7' : '#1d1d1f'
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex: number }>
        if (list.length === 0) return ''
        const i = list[0].dataIndex
        const label = series.value.labels[i] ?? ''
        const calls = series.value.calls[i] ?? 0
        const fails = series.value.fails[i] ?? 0
        const tokens = series.value.tokens[i] ?? 0
        const cost = series.value.costs[i] ?? 0
        return [
          label,
          `调用：${formatNumber(calls)} 次（失败 ${formatNumber(fails)}）`,
          `Token：${formatNumber(tokens)}`,
          `成本：${formatCost(cost)}`,
        ].join('<br/>')
      },
    },
    legend: {
      data: ['Token', '成本'],
      textStyle: { color: axisColor, fontSize: 12 },
      top: 0,
    },
    grid: { left: 8, right: 12, top: 32, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: series.value.labels,
      axisLabel: { color: axisColor, fontSize: 11 },
      axisLine: { lineStyle: { color: splitLine } },
    },
    yAxis: [
      {
        type: 'value',
        name: 'Token',
        nameTextStyle: { color: axisColor },
        axisLabel: { color: axisColor, fontSize: 11, formatter: (v: number) => formatNumber(v) },
        splitLine: { lineStyle: { color: splitLine } },
      },
      {
        type: 'value',
        name: '成本',
        nameTextStyle: { color: axisColor },
        axisLabel: { color: axisColor, fontSize: 11, formatter: (v: number) => formatCost(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Token',
        type: 'bar',
        data: series.value.tokens,
        itemStyle: { color: CHART_PALETTE[0], borderRadius: [2, 2, 0, 0] },
        barMaxWidth: 22,
      },
      {
        name: '成本',
        type: 'line',
        yAxisIndex: 1,
        data: series.value.costs,
        itemStyle: { color: CHART_PALETTE[2] },
        lineStyle: { width: 1.5 },
        symbol: 'circle',
        symbolSize: 4,
        smooth: false,
      },
    ],
  }
})
</script>

<style scoped>
.usage-trend {
  min-height: 300px;
}

.trend-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}
</style>
