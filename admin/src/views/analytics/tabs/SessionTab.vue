<template>
  <div class="session-tab">
    <el-row :gutter="16" class="block-row">
      <el-col :xs="24" :md="14">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>会话结局分布</span>
              <span class="card-hint">窗口内创建的会话</span>
            </div>
          </template>
          <BaseChart
            :option="donutOption(phaseItems, '会话总数', formatCompact(periodSessions))"
            :empty="phaseItems.length === 0"
            :height="300"
          />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="10">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>会话结构</span>
              <el-button type="primary" link @click="go('/sessions')">会话管理</el-button>
            </div>
          </template>
          <div class="struct-section">
            <div class="struct-title">类型</div>
            <div class="struct-rows">
              <div v-for="item in typeRows" :key="item.sessionType" class="struct-row">
                <span class="name">{{ typeLabel(item.sessionType) }}</span>
                <span class="value">{{ formatNumber(item.count) }}</span>
              </div>
              <div v-if="typeRows.length === 0" class="struct-empty">窗口内暂无会话</div>
            </div>
          </div>
          <div class="struct-section">
            <div class="struct-title">执行模式</div>
            <div class="struct-rows">
              <div v-for="item in modeRows" :key="item.executionMode" class="struct-row">
                <span class="name">{{ executionModeLabel(item.executionMode) }}</span>
                <span class="value">{{ formatNumber(item.count) }}</span>
              </div>
              <div v-if="modeRows.length === 0" class="struct-empty">窗口内暂无会话</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>运行态与结局</span>
          <span class="card-hint">实时 phase 快照 + 窗口完成/失败</span>
        </div>
      </template>
      <div class="live-grid">
        <div v-for="item in liveRows" :key="item.phase" class="live-item">
          <span class="phase-label" :style="{ color: phaseColor(item.phase) }">{{ phaseLabel(item.phase) }}</span>
          <span class="phase-value">{{ formatNumber(item.count) }}</span>
        </div>
      </div>
      <div class="session-kpis">
        <div class="kpi">
          <span class="label">窗口会话</span>
          <span class="value">{{ formatNumber(periodSessions) }}</span>
        </div>
        <div class="kpi">
          <span class="label">完成</span>
          <span class="value">{{ formatNumber(completedSessions) }}</span>
        </div>
        <div class="kpi">
          <span class="label">失败</span>
          <span class="value warn">{{ formatNumber(failedSessions) }}</span>
        </div>
        <div class="kpi">
          <span class="label">失败率</span>
          <span class="value">{{ failureRate }}%</span>
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" link @click="go('/sessions?phase=FAILED')">查看失败会话</el-button>
        <el-button link @click="go(withWindow('/llm-call?success=false'))">查看失败调用</el-button>
      </div>
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>调用质量</span>
          <span class="card-hint">
            llm_call 窗口聚合{{ excludeConnectivity === false ? '（含连通性测试）' : '，默认排除连通性测试' }}
          </span>
        </div>
      </template>
      <div class="quality-grid">
        <div v-for="item in qualityItems" :key="item.label" class="quality-item">
          <span class="label">{{ item.label }}</span>
          <span class="value">{{ item.value }}</span>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" class="block-row">
      <el-col :xs="24" :md="12">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>失败切片 · 模型 Top5</span>
              <span class="card-hint">窗口内 llm_call 失败次数</span>
            </div>
          </template>
          <div class="fail-rows">
            <div v-for="item in failByModel" :key="`m-${item.key}`" class="fail-row">
              <button
                v-if="typeof item.key === 'number' && item.key > 0"
                class="linkish"
                type="button"
                @click="go(withWindow(`/llm-call?success=false&modelId=${item.key}`))"
              >
                {{ item.name }}
              </button>
              <span v-else class="name">{{ item.name }}</span>
              <span class="fail">{{ formatNumber(item.failCount) }}</span>
              <span class="meta">/ {{ formatNumber(item.callCount) }} 次</span>
            </div>
            <div v-if="failByModel.length === 0" class="struct-empty">窗口内无失败调用</div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card class="block">
          <template #header>
            <div class="card-header">
              <span>失败切片 · 场景 Top5</span>
              <el-button type="primary" link @click="go('/llm-call?success=false')">调用流水</el-button>
            </div>
          </template>
          <div class="fail-rows">
            <div v-for="item in failByScene" :key="`s-${item.key}`" class="fail-row">
              <button class="linkish" type="button" @click="go(withWindow(`/llm-call?success=false&scene=${item.key}`))">
                {{ sceneLabel(String(item.key)) }}
              </button>
              <span class="fail">{{ formatNumber(item.failCount) }}</span>
              <span class="meta">/ {{ formatNumber(item.callCount) }} 次</span>
            </div>
            <div v-if="failByScene.length === 0" class="struct-empty">窗口内无失败调用</div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import { phaseLabel, executionModeLabel } from '../../../utils/labels'
import { llmCallSceneLabel, formatMs } from '../../../utils/llmCallLabels'
import { donutOption, formatCompact, formatNumber, phaseColor, phaseRankItems, type RankItem } from '../chart-options'
import type { SessionsPayload } from '../types'

const props = defineProps<{ payload: SessionsPayload | null; loading?: boolean }>()
const router = useRouter()

const phaseItems = computed<RankItem[]>(() => phaseRankItems(props.payload?.phaseDistribution || []))
const typeRows = computed(() => props.payload?.sessionTypes || [])
const modeRows = computed(() => props.payload?.executionModes || [])
const liveRows = computed(() => (props.payload?.livePhases || []).filter((row) => row.count > 0))
const periodSessions = computed(() => props.payload?.periodTotals?.sessions || 0)
const completedSessions = computed(() => props.payload?.periodTotals?.completedSessions || 0)
const failedSessions = computed(() => props.payload?.periodTotals?.failedSessions || 0)
const excludeConnectivity = computed(() => props.payload?.excludeConnectivity)
const quality = computed(() => props.payload?.callQuality)
const failByModel = computed(() => props.payload?.failTop?.byModel || [])
const failByScene = computed(() => props.payload?.failTop?.byScene || [])

const failureRate = computed(() => {
  const base = completedSessions.value + failedSessions.value
  if (base <= 0) return 0
  return Math.round((failedSessions.value / base) * 100)
})

const qualityItems = computed(() => {
  const q = quality.value
  if (!q) return []
  return [
    { label: '调用次数', value: formatNumber(q.callCount || 0) },
    { label: '失败次数', value: formatNumber(q.failCount || 0) },
    { label: '成功率', value: q.successRate == null ? '-' : `${q.successRate}%` },
    { label: '重试占比', value: q.retryRatio == null ? '-' : `${q.retryRatio}%` },
    { label: '缓存命中率', value: q.cacheHitRate == null ? '-' : `${q.cacheHitRate}%` },
    { label: '首 token p50', value: formatMs(q.firstTokenP50) },
    { label: '首 token p95', value: formatMs(q.firstTokenP95) },
    { label: '总耗时 p50', value: formatMs(q.durationP50) },
    { label: '总耗时 p95', value: formatMs(q.durationP95) }
  ]
})

function typeLabel(type: string): string {
  if (type === 'NORMAL') return '普通会话'
  if (type === 'SUBAGENT') return '子智能体'
  if (type === 'SIDE_TASK') return '边路任务'
  return type
}

function sceneLabel(scene: string): string {
  return llmCallSceneLabel(scene)
}

/** 后端统计窗口是 YYYY-MM-DD 日期区间；SessionListView 不消费时间参数，仅 llm-call 支持透传 */
function withWindow(path: string): string {
  const meta = props.payload?.period
  if (!meta) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}startDate=${meta.start}&endDate=${meta.end}`
}

function go(path: string) {
  router.push(path)
}
</script>

<script lang="ts">
export default { name: 'SessionTab' }
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

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.struct-section + .struct-section {
  margin-top: 16px;
}

.struct-title {
  font-size: 13px;
  color: var(--mao-muted);
  margin-bottom: 8px;
}

.struct-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--mao-border);
  font-size: 13px;
}

.struct-row .name {
  color: var(--mao-ink);
}

.struct-row .value {
  font-weight: 600;
  color: var(--mao-ink);
}

.struct-empty {
  font-size: 13px;
  color: var(--mao-muted);
}

.live-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.live-item {
  padding: 10px 12px;
  background: var(--mao-canvas);
  border-radius: 8px;
}

.phase-label {
  display: block;
  font-size: 12px;
}

.phase-value {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--mao-ink);
}

.session-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.kpi .label {
  display: block;
  font-size: 12px;
  color: var(--mao-muted);
}

.kpi .value {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--mao-ink);
}

.kpi .value.warn {
  color: #ff3b30;
}

.actions {
  margin-top: 16px;
}

.quality-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 16px;
}

.quality-item {
  padding: 10px 12px;
  background: var(--mao-canvas);
  border-radius: 8px;
}

.quality-item .label {
  display: block;
  font-size: 12px;
  color: var(--mao-muted);
}

.quality-item .value {
  display: block;
  margin-top: 4px;
  font-size: 18px;
  font-weight: 700;
  color: var(--mao-ink);
}

.fail-rows {
  display: flex;
  flex-direction: column;
}

.fail-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--mao-border);
  font-size: 13px;
}

.fail-row:last-child {
  border-bottom: none;
}

.fail-row .name {
  color: var(--mao-ink);
}

.fail-row .fail {
  font-weight: 600;
  color: #ff3b30;
}

.fail-row .meta {
  color: var(--mao-muted);
  min-width: 72px;
  text-align: right;
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

@media (max-width: 768px) {
  .session-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .quality-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
