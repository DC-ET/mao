<template>
  <div class="trends-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>流量趋势</span>
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
          <span>Token 消耗趋势</span>
          <span class="card-hint">对话消息 + 后台调用</span>
        </div>
      </template>
      <BaseChart :option="tokenOption" :empty="!hasTokens" :height="300" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { seriesTrendOption, tokenTrendOption as buildTokenTrendOption, type TrendPoint } from '../chart-options'
import type { TrendsPayload } from '../types'

const props = defineProps<{
  payload: TrendsPayload | null
  loading?: boolean
  error?: boolean
}>()

const trends = computed<TrendPoint[]>(() => props.payload?.trends || [])
const hasTraffic = computed(() => trends.value.some((t) => t.sessions > 0 || t.messages > 0))
const hasTokens = computed(() => trends.value.some((t) => t.totalTokens > 0))

const sessionTrendOption = computed(() =>
  seriesTrendOption(trends.value, [{ key: 'sessions', name: '会话', color: CHART_PALETTE[0] }])
)
const messageTrendOption = computed(() =>
  seriesTrendOption(trends.value, [{ key: 'messages', name: '消息', color: CHART_PALETTE[1] }])
)
const tokenOption = computed(() => buildTokenTrendOption(trends.value))
</script>

<script lang="ts">
export default { name: 'TrendsTab' }
</script>

<style scoped>
.block {
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

.mini-title {
  font-size: 13px;
  color: var(--mao-muted);
  margin-bottom: 4px;
}
</style>
