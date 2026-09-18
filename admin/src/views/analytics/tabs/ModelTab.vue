<template>
  <div class="model-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>模型 Token 占比</span>
          <div class="header-actions">
            <el-checkbox
              v-model="includeConnectivity"
              @change="handleConnectivityChange"
            >
              含自检调用
            </el-checkbox>
            <el-button type="primary" link @click="go('/models')">模型管理</el-button>
          </div>
        </div>
      </template>
      <BaseChart
        :option="donutOption(modelTokenItems, 'Token 总量', formatCompact(totalTokens))"
        :empty="modelTokenItems.length === 0"
        :height="300"
      />
    </el-card>

    <el-row :gutter="16" class="block-row">
      <el-col :xs="24" :md="12">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>场景分布</span>
              <span class="card-hint">{{ sceneHint }}</span>
            </div>
          </template>
          <div class="dist-rows">
            <div v-for="item in sceneRows" :key="item.key" class="dist-row">
              <button class="linkish" type="button" @click="go(`/llm-call?scene=${item.key}`)">
                {{ sceneLabel(item.key) }}
              </button>
              <span class="tokens">{{ formatNumber(item.callTokens) }}</span>
              <span class="meta">{{ formatNumber(item.callCount) }} 次</span>
            </div>
            <div v-if="sceneRows.length === 0" class="dist-empty">窗口内暂无调用流水</div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>协议分布</span>
              <span class="card-hint">llm_call.protocol</span>
            </div>
          </template>
          <div class="dist-rows">
            <div v-for="item in protocolRows" :key="item.key" class="dist-row">
              <span class="name">{{ item.key }}</span>
              <span class="tokens">{{ formatNumber(item.callTokens) }}</span>
              <span class="meta">{{ formatNumber(item.callCount) }} 次</span>
            </div>
            <div v-if="protocolRows.length === 0" class="dist-empty">窗口内暂无调用流水</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>模型用量明细</span>
          <div class="header-actions">
            <span class="card-hint">质量列来自 llm_call，延迟为均值</span>
            <el-button type="primary" link @click="go('/llm-call')">调用流水</el-button>
          </div>
        </div>
      </template>
      <el-table :data="modelStats" size="small" stripe @row-click="handleRowClick">
        <template #empty>
          <el-empty description="窗口内暂无模型调用" :image-size="48" />
        </template>
        <el-table-column label="模型" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <button class="linkish" type="button" @click.stop="go(`/llm-call?modelId=${row.modelId}`)">
              {{ row.modelName || '未命名' }}
            </button>
          </template>
        </el-table-column>
        <el-table-column prop="provider" label="供应商" width="110" class-name="hide-on-mobile" />
        <el-table-column label="会话" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.sessionCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="调用" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.callCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="成功率" width="90" align="right">
          <template #default="{ row }">{{ rateText(row.callSuccessRate) }}</template>
        </el-table-column>
        <el-table-column label="对话 Token" width="110" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.chatTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="调用 Token" width="110" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.callTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="Token 合计" width="110" align="right">
          <template #default="{ row }">
            <strong>{{ formatNumber(row.totalTokens || 0) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="缓存命中" width="100" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ rateText(row.cacheHitRate) }}</template>
        </el-table-column>
        <el-table-column label="首 token 均值" width="110" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ msText(row.avgFirstTokenMs) }}</template>
        </el-table-column>
        <el-table-column label="耗时均值" width="100" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ msText(row.avgDurationMs) }}</template>
        </el-table-column>
        <el-table-column label="占比" min-width="120">
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
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { llmCallSceneLabel, formatMs } from '../../../utils/llmCallLabels'
import { donutOption, formatCompact, formatNumber, topWithOthers, type RankItem } from '../chart-options'
import { percent } from '../composables/metrics'
import type { ModelsPayload } from '../types'

const props = defineProps<{ payload: ModelsPayload | null; loading?: boolean; error?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelId', value: number | undefined): void; (e: 'refresh', includeConnectivity: boolean): void }>()
const router = useRouter()

const selectedModelId = ref<number | undefined>(undefined)
const includeConnectivity = ref(true)

watch(
  () => props.payload?.sceneModelId,
  (value) => {
    selectedModelId.value = value == null ? undefined : Number(value)
  },
  { immediate: true }
)

watch(
  () => props.payload?.excludeConnectivity,
  (value) => {
    includeConnectivity.value = value !== false
  },
  { immediate: true }
)

const modelStats = computed(() => props.payload?.modelStats || [])
const totalTokens = computed(() => props.payload?.periodTotals?.totalTokens || 0)
const sceneRows = computed(() => props.payload?.sceneStats || [])
const protocolRows = computed(() => props.payload?.protocolStats || [])
const sceneHint = computed(() => {
  if (selectedModelId.value == null) return '全部模型合计；点击表行切换'
  const row = modelStats.value.find((item) => item.modelId === selectedModelId.value)
  return row ? `已选：${row.modelName}` : `模型 ${selectedModelId.value}`
})

const modelTokenItems = computed<RankItem[]>(() =>
  topWithOthers(
    modelStats.value.map((row) => ({ name: row.modelName || '未命名', value: Number(row.totalTokens || 0) })),
    10
  )
)

function tokenShare(value: unknown): number {
  return percent(Number(value || 0), totalTokens.value)
}

function rateText(value: unknown): string {
  if (value == null) return '-'
  return `${value}%`
}

function msText(value: unknown): string {
  return formatMs(value == null ? null : Number(value))
}

function sceneLabel(scene: string): string {
  return llmCallSceneLabel(scene)
}

function handleRowClick(row: { modelId: number }) {
  selectedModelId.value = row.modelId
  emit('update:modelId', row.modelId)
}

function handleConnectivityChange(value: boolean | string | number) {
  emit('refresh', Boolean(value))
}

function go(path: string) {
  router.push(path)
}
</script>

<script lang="ts">
export default { name: 'ModelTab' }
</script>

<style scoped>
.block,
.block-row {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-actions {
  display: flex;
  align-items: center;
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

.dist-rows {
  display: flex;
  flex-direction: column;
}

.dist-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--mao-border);
  font-size: 13px;
}

.dist-row:last-child {
  border-bottom: none;
}

.dist-row .name {
  color: var(--mao-ink);
}

.dist-row .tokens {
  font-weight: 600;
  color: var(--mao-ink);
}

.dist-row .meta {
  color: var(--mao-muted);
  min-width: 64px;
  text-align: right;
}

.dist-empty {
  font-size: 13px;
  color: var(--mao-muted);
}

.linkish {
  padding: 0;
  border: none;
  background: none;
  color: var(--mao-accent);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.linkish:hover {
  text-decoration: underline;
}
</style>
