<template>
  <div class="usage-trend" v-loading="loading">
    <el-empty v-if="!loading && !hasData" description="窗口内暂无用量数据" :image-size="48" />

    <template v-else>
      <div class="trend-block">
        <div class="trend-title">Token 趋势<span class="trend-sub">{{ granularityLabel }}分桶</span></div>
        <BaseChart :option="tokenOption" :height="260" />
      </div>
      <div class="trend-block">
        <div class="trend-title">请求数 / 缓存命中率趋势<span class="trend-sub">{{ granularityLabel }}分桶</span></div>
        <BaseChart :option="callOption" :height="260" />
      </div>
      <div class="trend-block">
        <div class="trend-title">成本趋势<span class="trend-sub">{{ granularityLabel }}分桶</span></div>
        <BaseChart :option="costOption" :height="260" />
      </div>

      <div class="trend-summary">
        <span>窗口调用 {{ formatNumber(series.totalCalls) }} 次</span>
        <span>Token {{ formatToken(series.totalTokens) }}</span>
        <span>成本 {{ formatCost(series.totalCost) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useTheme } from '../../utils/theme'
import { type ChartOption } from '../../utils/echarts'
import { fetchMyUsageTrends, type UsageRange, type UsageTrendBucket } from '../../api'
import { formatCost, formatNumber, formatToken, formatTokenWithUnit } from '../../utils/usageFormat'
import { buildTrendSeries } from './trend-series'
import { buildTrendLineOption, TREND_COLORS } from './trend-options'
import BaseChart from '../common/BaseChart.vue'

const props = defineProps<{
  range: UsageRange
  /** 抽屉「刷新」按钮令牌：变化即重拉，不 remount（保留图表实例） */
  refreshKey?: number
}>()

const { isDark } = useTheme()
const buckets = ref<UsageTrendBucket[]>([])
const loading = ref(false)

/** 单日周期（今日/昨日）按小时分桶，多日周期按天；后端据此补零。 */
const granularity = computed<'day' | 'hour'>(() =>
  props.range === 'today' || props.range === 'yesterday' ? 'hour' : 'day',
)
const granularityLabel = computed(() => (granularity.value === 'hour' ? '按小时' : '按天'))

let fetchSeq = 0
async function fetchTrends() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const data = await fetchMyUsageTrends(props.range, granularity.value)
    if (seq !== fetchSeq) return
    buckets.value = data?.buckets || []
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

onMounted(fetchTrends)
watch(() => props.range, fetchTrends)
watch(() => props.refreshKey, fetchTrends)

const series = computed(() => buildTrendSeries(buckets.value, granularity.value))
const hasData = computed(() => series.value.totalCalls > 0)

/** Token 折线：纵轴按窗口峰值整轴统一单位（读数形如 50M / 100M / 1B），tooltip 按值自适应。 */
const tokenOption = computed<ChartOption>(() => buildTrendLineOption({
  labels: series.value.labels,
  lines: [{
    name: 'Token',
    data: series.value.tokens,
    color: TREND_COLORS.token,
    tooltipFormat: (v) => formatToken(v),
  }],
  leftAxis: {
    name: 'Token',
    format: (v) => formatTokenWithUnit(v, series.value.tokenUnit),
  },
  isDark: isDark.value,
}))

/** 请求数（左轴，次）与缓存命中率（右轴，%）单位不同，双轴；命中率在无调用的桶断开。 */
const callOption = computed<ChartOption>(() => buildTrendLineOption({
  labels: series.value.labels,
  lines: [
    {
      name: '请求数',
      data: series.value.calls,
      color: TREND_COLORS.calls,
      tooltipFormat: (v) => `${formatNumber(v)} 次`,
    },
    {
      name: '缓存命中率',
      data: series.value.hitRates,
      color: TREND_COLORS.hitRate,
      right: true,
      tooltipFormat: (v) => `${v}%`,
    },
  ],
  leftAxis: {
    name: '请求数',
    format: (v) => formatNumber(v),
  },
  rightAxis: {
    name: '命中率',
    format: (v) => `${v}%`,
  },
  tooltipExtra: (i) => {
    const fails = series.value.fails[i] ?? 0
    return fails > 0 ? [`失败 ${formatNumber(fails)} 次`] : []
  },
  isDark: isDark.value,
}))

/** 成本折线：口径同总览卡片（模型价格填写单位，未配价不计入）。 */
const costOption = computed<ChartOption>(() => buildTrendLineOption({
  labels: series.value.labels,
  lines: [{
    name: '成本',
    data: series.value.costs,
    color: TREND_COLORS.cost,
    tooltipFormat: (v) => formatCost(v),
  }],
  leftAxis: {
    name: '成本',
    format: (v) => formatCost(v),
  },
  isDark: isDark.value,
}))
</script>

<style scoped>
.usage-trend {
  min-height: 300px;
}

.trend-block {
  margin-bottom: 20px;
}

.trend-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.trend-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--aw-ink-muted);
}

.trend-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}
</style>
