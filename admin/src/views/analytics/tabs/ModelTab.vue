<template>
  <div class="model-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>模型 Token 占比</span>
          <el-button type="primary" link @click="go('/models')">模型管理</el-button>
        </div>
      </template>
      <BaseChart
        :option="donutOption(modelTokenItems, 'Token 总量', formatCompact(totalTokens))"
        :empty="modelTokenItems.length === 0"
        :height="300"
      />
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>模型用量明细</span>
          <el-button type="primary" link @click="go('/llm-call')">调用流水</el-button>
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
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { donutOption, formatCompact, formatNumber, topWithOthers, type RankItem } from '../chart-options'
import { percent } from '../composables/metrics'
import type { ModelsPayload } from '../types'

const props = defineProps<{ payload: ModelsPayload | null; loading?: boolean; error?: boolean }>()
const router = useRouter()

const modelStats = computed(() => props.payload?.modelStats || [])
const totalTokens = computed(() => props.payload?.periodTotals?.totalTokens || 0)

const modelTokenItems = computed<RankItem[]>(() =>
  topWithOthers(
    modelStats.value.map((row) => ({ name: row.modelName || '未命名', value: Number(row.totalTokens || 0) })),
    10
  )
)

function tokenShare(value: unknown): number {
  return percent(Number(value || 0), totalTokens.value)
}

function go(path: string) {
  router.push(path)
}
</script>

<script lang="ts">
export default { name: 'ModelTab' }
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

.share-text {
  margin-left: 8px;
  font-size: 12px;
  color: var(--mao-muted);
}
</style>
