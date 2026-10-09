<template>
  <div class="run-trace-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>最慢的轮</span>
          <div class="header-actions">
            <span class="card-hint">窗口内每个{{ dimensionLabel }}最慢的一圈 {{ sceneLabel }} 调用</span>
            <el-button :disabled="slowest.length === 0" @click="exportSlowest">导出 CSV</el-button>
          </div>
        </div>
      </template>
      <el-table :data="slowest" size="small" stripe>
        <template #empty>
          <el-empty description="窗口内没有该口径的模型调用" :image-size="48" />
        </template>
        <el-table-column :label="dimensionLabel" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <button class="linkish" type="button" @click="goSessions(row)">{{ row.scopeName || '未知' }}</button>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="110" align="right">
          <template #default="{ row }">
            <strong>{{ formatMs(row.durationMs) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="模型" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.modelName || '-' }}</template>
        </el-table-column>
        <el-table-column label="Token" width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
        </el-table-column>
        <el-table-column label="成本" width="100" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatCost(row.costMicros == null ? null : row.costMicros / 1e6) }}</template>
        </el-table-column>
        <el-table-column label="窗口调用" width="100" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
        </el-table-column>
        <el-table-column label="结束时间" width="170" class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.createdAt || '-' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>最贵的轮</span>
          <div class="header-actions">
            <span class="card-hint">只统计已配置价格的调用（cost_micros 非空）</span>
            <el-button :disabled="expensive.length === 0" @click="exportExpensive">导出 CSV</el-button>
          </div>
        </div>
      </template>
      <el-table :data="expensive" size="small" stripe>
        <template #empty>
          <el-empty description="窗口内没有已配价的模型调用" :image-size="48" />
        </template>
        <el-table-column :label="dimensionLabel" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <button class="linkish" type="button" @click="goSessions(row)">{{ row.scopeName || '未知' }}</button>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="110" align="right">
          <template #default="{ row }">
            <strong>{{ formatCost(row.costMicros == null ? null : row.costMicros / 1e6) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="模型" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.modelName || '-' }}</template>
        </el-table-column>
        <el-table-column label="Token" width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="110" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatMs(row.durationMs) }}</template>
        </el-table-column>
        <el-table-column label="结束时间" width="170" class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.createdAt || '-' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>工具失败率</span>
          <div class="header-actions">
            <span class="card-hint">按工具类型分组，状态沿用活动表现有口径</span>
            <el-button :disabled="toolFailures.length === 0" @click="exportToolFailures">导出 CSV</el-button>
          </div>
        </div>
      </template>
      <el-table :data="toolFailures" size="small" stripe>
        <template #empty>
          <el-empty description="窗口内暂无工具活动" :image-size="48" />
        </template>
        <el-table-column label="工具类型" min-width="140">
          <template #default="{ row }">
            <span class="tool-type">{{ row.toolType }}</span>
          </template>
        </el-table-column>
        <el-table-column label="失败率" width="110" align="right">
          <template #default="{ row }">
            <strong :class="{ warn: row.failRate >= 20 }">{{ row.failRate }}%</strong>
          </template>
        </el-table-column>
        <el-table-column label="失败" width="90" align="right">
          <template #default="{ row }">{{ formatNumber(row.errorCount) }}</template>
        </el-table-column>
        <el-table-column label="总计" width="90" align="right">
          <template #default="{ row }">{{ formatNumber(row.totalCount) }}</template>
        </el-table-column>
        <el-table-column label="占比" min-width="160">
          <template #default="{ row }">
            <el-progress :percentage="row.failRate" :stroke-width="8" :show-text="false" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { formatMs, llmCallSceneLabel } from '../../../utils/llmCallLabels'
import { formatCost, formatNumber } from '../chart-options'
import { exportCsv } from '../utils/csv'
import type { RunTracePayload, RunTraceRoundRow, RunTraceToolFailureRow } from '../types'

const props = defineProps<{
  payload: RunTracePayload | null
  loading?: boolean
}>()

const router = useRouter()

const slowest = computed<RunTraceRoundRow[]>(() => props.payload?.slowestRounds ?? [])
const expensive = computed<RunTraceRoundRow[]>(() => props.payload?.mostExpensiveRounds ?? [])
const toolFailures = computed<RunTraceToolFailureRow[]>(() => props.payload?.toolFailureRates ?? [])
const dimensionLabel = computed(() => (props.payload?.scope === 'user' ? '用户' : 'Agent'))
const sceneLabel = computed(() => llmCallSceneLabel(props.payload?.scene ?? 'agent'))

function goSessions(row: RunTraceRoundRow) {
  const key = props.payload?.scope === 'user' ? 'userId' : 'agentId'
  void router.push(`/sessions?${key}=${row.scopeKey}`)
}

const ROUND_HEADER = ['Agent / 用户', '会话 ID', '模型', '结束时间', '耗时(ms)', 'Token', '成本']

/** 成本列与 llm-calls 导出口径一致：cost_micros / 1e6 六位小数，未配价留空。 */
function roundRows(rows: RunTraceRoundRow[]): Array<Array<string | number | null>> {
  return rows.map((row) => [
    row.scopeName,
    row.sessionId ?? '',
    row.modelName ?? '',
    row.createdAt ?? '',
    row.durationMs,
    row.totalTokens,
    row.costMicros == null ? '' : (row.costMicros / 1e6).toFixed(6),
  ])
}

function exportSlowest() {
  exportCsv(`run-trace-slowest-${stamp()}.csv`, ROUND_HEADER, roundRows(slowest.value))
}

function exportExpensive() {
  exportCsv(`run-trace-expensive-${stamp()}.csv`, ROUND_HEADER, roundRows(expensive.value))
}

function exportToolFailures() {
  exportCsv(
    `run-trace-tool-failure-${stamp()}.csv`,
    ['工具类型', '失败', '总计', '失败率(%)'],
    toolFailures.value.map((row) => [row.toolType, row.errorCount, row.totalCount, row.failRate])
  )
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}
</script>

<style scoped>
.run-trace-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.card-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.linkish {
  border: none;
  background: none;
  padding: 0;
  color: var(--el-color-primary);
  cursor: pointer;
  font: inherit;
}

.tool-type {
  font-family: var(--el-font-family-mono, monospace);
}

.warn {
  color: var(--el-color-danger);
}
</style>
