<template>
  <div class="usage-overview" v-loading="loading">
    <el-empty v-if="!loading && isEmpty" description="窗口内暂无用量数据" :image-size="48" />

    <template v-else>
      <div class="stat-grid">
        <div v-for="card in cards" :key="card.label" class="stat-card">
          <div class="stat-label">{{ card.label }}</div>
          <div class="stat-value">{{ card.value }}</div>
          <div v-if="card.hint" class="stat-hint">{{ card.hint }}</div>
        </div>
      </div>

      <div class="block">
        <div class="block-title">按模型</div>
        <el-table :data="modelRows" size="small" stripe>
          <template #empty>
            <el-empty description="暂无调用记录" :image-size="40" />
          </template>
          <el-table-column label="模型" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.modelName || '未知模型' }}</template>
          </el-table-column>
          <el-table-column label="调用" width="72" align="right">
            <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
          </el-table-column>
          <el-table-column label="失败" width="72" align="right">
            <template #default="{ row }">{{ formatNumber(row.failCount) }}</template>
          </el-table-column>
          <el-table-column label="入 Token" width="92" align="right">
            <template #default="{ row }">{{ formatToken(row.promptTokens) }}</template>
          </el-table-column>
          <el-table-column label="出 Token" width="92" align="right">
            <template #default="{ row }">{{ formatToken(row.completionTokens) }}</template>
          </el-table-column>
          <el-table-column label="总 Token" width="96" align="right">
            <template #default="{ row }">{{ formatToken(row.totalTokens) }}</template>
          </el-table-column>
          <el-table-column label="成本" width="88" align="right">
            <template #default="{ row }">{{ formatCost(row.cost) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div class="block">
        <div class="block-title">按场景</div>
        <el-table :data="sceneRows" size="small" stripe>
          <template #empty>
            <el-empty description="暂无调用记录" :image-size="40" />
          </template>
          <el-table-column label="场景" min-width="120">
            <template #default="{ row }">{{ llmCallSceneLabel(row.scene) }}</template>
          </el-table-column>
          <el-table-column label="调用" width="88" align="right">
            <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
          </el-table-column>
          <el-table-column label="失败" width="88" align="right">
            <template #default="{ row }">{{ formatNumber(row.failCount) }}</template>
          </el-table-column>
          <el-table-column label="总 Token" width="110" align="right">
            <template #default="{ row }">{{ formatToken(row.totalTokens) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <p class="cost-note">成本按模型价格填写口径估算；未配置价格的调用不计入成本。</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MyUsageSummary } from '../../api'
import { formatCost, formatNumber, formatPercent, formatToken } from '../../utils/usageFormat'
import { llmCallSceneLabel } from '../../utils/llmCallLabels'

const props = defineProps<{
  summary: MyUsageSummary | null
  loading: boolean
}>()

const modelRows = computed(() => props.summary?.byModel ?? [])
const sceneRows = computed(() => props.summary?.byScene ?? [])
const isEmpty = computed(() => (props.summary?.totals.callCount ?? 0) === 0)

const cards = computed(() => {
  const t = props.summary?.totals
  return [
    {
      label: '调用次数',
      value: formatNumber(t?.callCount ?? 0),
      hint: t && t.failCount > 0 ? `失败 ${formatNumber(t.failCount)} 次` : '',
    },
    {
      label: '总 Token',
      value: formatToken(t?.totalTokens ?? 0),
      hint: t ? `入 ${formatToken(t.promptTokens)} / 出 ${formatToken(t.completionTokens)}` : '',
    },
    {
      label: '估算成本',
      value: formatCost(t?.cost ?? 0),
      hint: '价格填写口径',
    },
    {
      label: '成功率',
      value: formatPercent(t?.successCount ?? 0, t?.callCount ?? 0),
      hint: '',
    },
    {
      label: '缓存命中率',
      value: formatPercent(t?.cachedTokens ?? 0, t?.promptTokens ?? 0),
      hint: t ? `命中 ${formatToken(t.cachedTokens)}` : '',
    },
  ]
})
</script>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.stat-card {
  padding: 12px 14px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
}

.stat-label {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.stat-value {
  margin-top: 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  font-variant-numeric: tabular-nums;
}

.stat-hint {
  margin-top: 2px;
  font-size: 11px;
  color: var(--aw-ink-muted);
}

.block {
  margin-bottom: 18px;
}

.block-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.cost-note {
  margin: 0;
  font-size: 11px;
  color: var(--aw-ink-muted);
}
</style>
