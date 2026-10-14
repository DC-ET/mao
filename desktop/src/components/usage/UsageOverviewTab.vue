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

      <div class="pie-grid">
        <div class="block">
          <div class="block-title">按模型</div>
          <UsagePieChart :slices="modelSlices" />
        </div>
        <div class="block">
          <div class="block-title">按场景</div>
          <UsagePieChart :slices="sceneSlices" />
        </div>
        <div class="block">
          <div class="block-title">按 Agent</div>
          <UsagePieChart :slices="agentSlices" />
        </div>
      </div>

      <p class="cost-note">饼图按调用次数占比，悬浮可看该维度的调用数、Token 与成本。成本按模型价格填写口径估算，未配置价格的调用不计入成本。</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MyUsageSummary } from '../../api'
import { formatCost, formatNumber, formatPercent, formatToken } from '../../utils/usageFormat'
import { llmCallSceneLabel } from '../../utils/llmCallLabels'
import { buildPieSlices } from './pie-series'
import UsagePieChart from './UsagePieChart.vue'

const props = defineProps<{
  summary: MyUsageSummary | null
  loading: boolean
}>()

const isEmpty = computed(() => (props.summary?.totals.callCount ?? 0) === 0)

/** 三个维度共用一套饼图：按调用次数占比，尾部合并「其他」，悬浮看 Token/成本明细。 */
const modelSlices = computed(() => buildPieSlices((props.summary?.byModel ?? []).map((r) => ({
  name: r.modelName || '未知模型',
  callCount: r.callCount,
  totalTokens: r.totalTokens,
  cost: r.cost,
}))))

const sceneSlices = computed(() => buildPieSlices((props.summary?.byScene ?? []).map((r) => ({
  name: llmCallSceneLabel(r.scene),
  callCount: r.callCount,
  totalTokens: r.totalTokens,
}))))

const agentSlices = computed(() => buildPieSlices((props.summary?.byAgent ?? []).map((r) => ({
  // 无归属调用（压缩/标题等系统场景）agentId 为 null；Agent 已删查不到名字时兜底用 ID
  name: r.agentName || (r.agentId != null ? `Agent #${r.agentId}` : '无 Agent'),
  callCount: r.callCount,
  totalTokens: r.totalTokens,
  cost: r.cost,
}))))

const cards = computed(() => {
  const t = props.summary?.totals
  const failHint = t && t.failCount > 0 ? `失败 ${formatNumber(t.failCount)} 次` : ''
  const cancelHint = t && t.cancelledCount > 0 ? `取消 ${formatNumber(t.cancelledCount)} 次` : ''
  return [
    {
      label: '调用次数',
      value: formatNumber(t?.callCount ?? 0),
      hint: [failHint, cancelHint].filter(Boolean).join(' / '),
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
      // 取消不是失败：分母 = 调用数 − 取消数，用户主动停止不再拉低成功率
      value: formatPercent(t?.successCount ?? 0, (t?.callCount ?? 0) - (t?.cancelledCount ?? 0)),
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

.pie-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 18px;
  margin-bottom: 18px;
}

.block {
  min-width: 0;
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
