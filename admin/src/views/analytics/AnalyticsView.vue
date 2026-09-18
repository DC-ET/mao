<template>
  <div class="analytics-view">
    <el-card class="toolbar-card">
      <div class="toolbar">
        <div class="toolbar-info">
          <div class="toolbar-title">用量分析</div>
          <div class="toolbar-hint">
            {{ periodText }}，环比对照 {{ previousText }}；数字均为窗口内新增。环比色：绿=变好、红=变差。
          </div>
        </div>
        <div class="toolbar-actions">
          <span class="toolbar-label">统计周期</span>
          <el-segmented v-model="period" :options="periodOptions" @change="handlePeriodChange" />
          <el-button :loading="activeLoading" @click="handleRefresh">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </div>
    </el-card>

    <el-tabs v-model="activeTab" class="analytics-tabs" @tab-change="handleTabChange">
      <el-tab-pane v-for="tab in TABS" :key="tab.value" :label="tab.label" :name="tab.value" />
    </el-tabs>

    <TabError v-if="activeError" :loading="activeLoading" @retry="handleRefresh" />
    <div v-else-if="!hasData" class="panel-loading" v-loading="true" />
    <TabEmpty
      v-else-if="isEmpty && activeTab !== 'overview'"
      :title="emptyCopy.title"
      :hint="emptyCopy.hint"
      @relax="relaxPeriod"
    />
    <template v-else>
      <OverviewTab
        v-if="activeTab === 'overview'"
        :payload="overviewPayload"
        :loading="activeLoading"
        :error="activeError"
        :period-text="periodText"
        :previous-text="previousText"
      />
      <TrendsTab
        v-else-if="activeTab === 'trends'"
        :payload="trendsPayload"
        :loading="activeLoading"
        :error="activeError"
      />
      <ModelTab
        v-else-if="activeTab === 'models'"
        :payload="modelsPayload"
        :loading="activeLoading"
        :error="activeError"
        @update:model-id="handleSceneModelChange"
        @refresh="handleModelsRefresh"
      />
      <UserTab
        v-else-if="activeTab === 'users'"
        :payload="usersPayload"
        :loading="activeLoading"
        :error="activeError"
      />
      <AgentTab
        v-else-if="activeTab === 'agents'"
        :payload="agentsPayload"
        :loading="activeLoading"
        :error="activeError"
      />
      <SessionTab
        v-else-if="activeTab === 'sessions'"
        :payload="sessionsPayload"
        :loading="activeLoading"
        :error="activeError"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invalidateAnalytics, useScopeQuery } from './composables/useScopeQuery'
import {
  PERIOD_OPTIONS,
  buildAnalyticsQuery,
  periodFromQueryValue,
  periodToQueryValue
} from './composables/useAnalyticsPeriod'
import type {
  AgentsPayload,
  ModelsPayload,
  OverviewPayload,
  PeriodValue,
  SessionsPayload,
  TrendsPayload,
  UsersPayload
} from './types'
import OverviewTab from './tabs/OverviewTab.vue'
import TrendsTab from './tabs/TrendsTab.vue'
import ModelTab from './tabs/ModelTab.vue'
import UserTab from './tabs/UserTab.vue'
import AgentTab from './tabs/AgentTab.vue'
import SessionTab from './tabs/SessionTab.vue'
import TabEmpty from './tabs/TabEmpty.vue'
import TabError from './tabs/TabError.vue'

const TABS = [
  { label: '总览', value: 'overview' },
  { label: '趋势', value: 'trends' },
  { label: '模型', value: 'models' },
  { label: '用户', value: 'users' },
  { label: 'Agent', value: 'agents' },
  { label: '会话', value: 'sessions' }
] as const

type TabId = (typeof TABS)[number]['value']

const route = useRoute()
const router = useRouter()

const period = ref<PeriodValue>(periodFromQueryValue(route.query.period ?? route.query.days ?? 'today'))
const activeTab = ref<TabId>(normalizeTab(route.query.tab))
const sceneModelId = ref<number | undefined>(
  route.query.modelId != null && route.query.modelId !== '' ? Number(route.query.modelId) : undefined
)
const includeConnectivity = ref(true)
const periodOptions = PERIOD_OPTIONS

const overview = useScopeQuery<OverviewPayload>('overview')
const trends = useScopeQuery<TrendsPayload>('trends')
const models = useScopeQuery<ModelsPayload>('models')
const users = useScopeQuery<UsersPayload>('users')
const agents = useScopeQuery<AgentsPayload>('agents')
const sessions = useScopeQuery<SessionsPayload>('sessions')

const scopeMap = {
  overview,
  trends,
  models,
  users,
  agents,
  sessions
} as const

const activeScope = computed(() => scopeMap[activeTab.value])
const activeLoading = computed(() => activeScope.value.loading.value)
const activeError = computed(() => activeScope.value.error.value)
const hasData = computed(() => activeScope.value.data.value != null)

const overviewPayload = computed(() => overview.data.value)
const trendsPayload = computed(() => trends.data.value)
const modelsPayload = computed(() => models.data.value)
const usersPayload = computed(() => users.data.value)
const agentsPayload = computed(() => agents.data.value)
const sessionsPayload = computed(() => sessions.data.value)

const periodText = computed(() => {
  const meta = (activeScope.value.data.value as { period?: { start: string; end: string; days: number } } | null)
    ?.period
  if (meta) return `${meta.start} ~ ${meta.end}（${meta.days} 天）`
  const { days, endOffset } = buildAnalyticsQuery(period.value)
  if (days === 1 && endOffset === 0) return '今日 00:00 起'
  if (days === 1 && endOffset === 1) return '昨日 00:00 起'
  return `近 ${days} 天`
})

const previousText = computed(() => {
  const meta = (activeScope.value.data.value as { period?: { previousStart: string; previousEnd: string } } | null)
    ?.period
  if (meta) return `${meta.previousStart} ~ ${meta.previousEnd}`
  return '上一周期'
})

const isEmpty = computed(() => {
  const data = activeScope.value.data.value as Record<string, unknown> | null
  if (!data) return false
  if (activeTab.value === 'overview') {
    const totals = (data.periodTotals || {}) as Partial<OverviewPayload['periodTotals']>
    return (totals.sessions ?? 0) === 0 && (totals.messages ?? 0) === 0 && (totals.totalTokens ?? 0) === 0
  }
  if (activeTab.value === 'trends') {
    return ((data.trends as TrendsPayload['trends']) || []).every(
      (row) => row.sessions === 0 && row.messages === 0 && row.totalTokens === 0
    )
  }
  if (activeTab.value === 'models') return ((data.modelStats as ModelsPayload['modelStats']) || []).length === 0
  if (activeTab.value === 'users') return ((data.userActivity as UsersPayload['userActivity']) || []).length === 0
  if (activeTab.value === 'agents') return ((data.agentStats as AgentsPayload['agentStats']) || []).length === 0
  if (activeTab.value === 'sessions') {
    return ((data.phaseDistribution as Array<{ count: number }>) || []).every((row) => Number(row.count || 0) === 0)
  }
  return false
})

const emptyCopy = computed(() => {
  switch (activeTab.value) {
    case 'models':
      return { title: '窗口内暂无模型调用', hint: '可放宽统计周期，或先在模型管理中确认可用模型。' }
    case 'users':
      return { title: '窗口内暂无用户活跃', hint: '该周期没有创建会话或发送消息的用户。' }
    case 'agents':
      return { title: '窗口内暂无 Agent 活跃', hint: '该周期没有创建会话或发送消息的 Agent。' }
    case 'sessions':
      return { title: '窗口内暂无会话', hint: '可切换更长周期，或确认是否有用户在使用。' }
    case 'trends':
      return { title: '窗口内暂无趋势数据', hint: '可切换更长周期观察波动。' }
    default:
      return { title: '当前时间窗内没有数据', hint: '可能周期太短、尚无用户使用，或筛选过严。' }
  }
})

function normalizeTab(raw: unknown): TabId {
  const value = String(raw || 'overview')
  return (TABS.some((tab) => tab.value === value) ? value : 'overview') as TabId
}

function currentQuery() {
  const needsLimit = activeTab.value === 'users' || activeTab.value === 'agents'
  const query = buildAnalyticsQuery(period.value, needsLimit ? 20 : undefined)
  const withConnectivity = { ...query, excludeConnectivity: !includeConnectivity.value }
  if (activeTab.value === 'models' && sceneModelId.value != null && Number.isFinite(sceneModelId.value)) {
    return { ...withConnectivity, modelId: sceneModelId.value }
  }
  return withConnectivity
}

async function loadActive(force = false) {
  await activeScope.value.fetchScope(currentQuery(), force)
}

function handleSceneModelChange(modelId: number | undefined) {
  sceneModelId.value = modelId
  if (activeTab.value !== 'models') return
  invalidateAnalytics('models')
  void loadActive(true)
}

function handleModelsRefresh(include: boolean) {
  includeConnectivity.value = include
  invalidateAnalytics('models')
  void loadActive(true)
}

function syncUrl() {
  const nextTab = activeTab.value
  const nextPeriod = periodToQueryValue(period.value)
  if (route.query.tab === nextTab && route.query.period === nextPeriod) return
  router.replace({
    query: {
      ...route.query,
      tab: nextTab,
      period: nextPeriod
    }
  })
}

function handleTabChange(name: TabId | string) {
  activeTab.value = normalizeTab(name)
  syncUrl()
  void loadActive(false)
}

function handlePeriodChange() {
  invalidateAnalytics()
  syncUrl()
  void loadActive(true)
}

function handleRefresh() {
  invalidateAnalytics(activeTab.value)
  void loadActive(true)
}

function relaxPeriod() {
  period.value = 7
  handlePeriodChange()
}

watch(
  () => [route.query.tab, route.query.period] as const,
  ([tabValue, periodValue]) => {
    const nextTab = normalizeTab(tabValue)
    const nextPeriod = periodFromQueryValue(periodValue ?? 'today')
    const periodChanged = nextPeriod !== period.value
    if (periodChanged) {
      period.value = nextPeriod
      invalidateAnalytics()
    }
    if (nextTab !== activeTab.value || periodChanged) {
      activeTab.value = nextTab
      void loadActive(true)
    }
  }
)

onMounted(() => {
  syncUrl()
  void loadActive(false)
})
</script>

<style scoped>
.toolbar-card {
  margin-bottom: 12px;
}

.analytics-tabs {
  margin-bottom: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.toolbar-hint {
  margin-top: 4px;
  font-size: 13px;
  color: var(--mao-muted);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.panel-loading {
  min-height: 280px;
}

@media (max-width: 768px) {
  .toolbar {
    flex-wrap: wrap;
  }

  .toolbar-actions {
    width: 100%;
  }
}
</style>
