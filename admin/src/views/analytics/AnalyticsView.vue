<template>
  <div class="analytics-view">
    <el-card class="toolbar-card">
      <div class="toolbar">
        <div class="toolbar-info">
          <div class="toolbar-title">用量分析</div>
          <div class="toolbar-hint">
            {{ periodText }}，环比对照 {{ previousText }}；数字均为窗口内新增。环比色：绿=变好、红=变差。
            <span v-if="fetchedAtText">· 数据获取于 {{ fetchedAtText }}</span>
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
    <div v-else-if="!activeHasData" class="panel-loading" v-loading="true" />
    <TabEmpty
      v-else-if="activeTab !== 'overview' && isEmpty"
      :title="emptyCopy.title"
      :hint="emptyCopy.hint"
      @relax="relaxPeriod"
    />
    <OverviewEmpty v-else-if="isOverviewEmpty" />
    <template v-else>
      <OverviewTab
        v-if="activeTab === 'overview'"
        :payload="overviewPayload"
        :loading="activeLoading"
        :period-text="periodText"
        :previous-text="previousText"
      />
      <TrendsTab
        v-else-if="activeTab === 'trends'"
        :payload="trendsPayload"
        :loading="activeLoading"
        :view="trendView"
        @update:view="handleTrendViewChange"
      />
      <ModelTab
        v-else-if="activeTab === 'models'"
        :payload="modelsPayload"
        :loading="activeLoading"
        @update:model-id="handleSceneModelChange"
        @update:include-connectivity="handleModelsRefresh"
      />
      <UserTab
        v-else-if="activeTab === 'users'"
        :payload="usersPayload"
        :loading="activeLoading"
      />
      <AgentTab
        v-else-if="activeTab === 'agents'"
        :payload="agentsPayload"
        :loading="activeLoading"
      />
      <SessionTab
        v-else-if="activeTab === 'sessions'"
        :payload="sessionsPayload"
        :loading="activeLoading"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { invalidateAnalytics, useScopeQuery } from './composables/useScopeQuery'
import {
  PERIOD_OPTIONS,
  buildAnalyticsQuery,
  periodFromQueryValue,
  periodToQueryValue
} from './composables/useAnalyticsPeriod'
import { formatDateTime } from '../../utils/datetime'

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
import OverviewEmpty from './tabs/OverviewEmpty.vue'

const TABS = [
  { label: '总览', value: 'overview' },
  { label: '趋势', value: 'trends' },
  { label: '模型', value: 'models' },
  { label: '用户', value: 'users' },
  { label: 'Agent', value: 'agents' },
  { label: '会话', value: 'sessions' }
] as const

type TabId = (typeof TABS)[number]['value']
type TrendView = 'traffic' | 'token' | 'calls' | 'quality'
const TREND_VIEWS: readonly string[] = ['traffic', 'token', 'calls', 'quality']

const EMPTY_COPY: Record<Exclude<TabId, 'overview'>, { title: string; hint: string }> = {
  trends: { title: '窗口内暂无趋势数据', hint: '可切换更长周期观察波动。' },
  models: { title: '窗口内暂无模型调用', hint: '可放宽统计周期，或先在模型管理中确认可用模型。' },
  users: { title: '窗口内暂无用户活跃', hint: '该周期没有创建会话或发送消息的用户。' },
  agents: { title: '窗口内暂无 Agent 活跃', hint: '该周期没有创建会话或发送消息的 Agent。' },
  sessions: { title: '窗口内暂无会话', hint: '可切换更长周期，或确认是否有用户在使用。' }
}

const route = useRoute()
const router = useRouter()

const period = ref<PeriodValue>(periodFromQueryValue(route.query.period ?? route.query.days ?? 'today'))
const activeTab = ref<TabId>(normalizeTab(route.query.tab))
const trendView = ref<TrendView>(normalizeTrendView(route.query.view))
const sceneModelId = ref<number | undefined>(
  route.query.modelId != null && route.query.modelId !== '' ? Number(route.query.modelId) : undefined
)
// 「含自检调用」开关仅属于模型 Tab：默认含（URL 无 conn 时），conn=0 表示排除
const includeConnectivity = ref(route.query.conn !== '0')
const periodOptions = PERIOD_OPTIONS
let everLoaded = false

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
const activeHasData = computed(() => activeScope.value.data.value != null)
const activeFetchedAt = computed(() => activeScope.value.fetchedAt.value)

const overviewPayload = computed(() => overview.data.value)
const trendsPayload = computed(() => trends.data.value)
const modelsPayload = computed(() => models.data.value)
const usersPayload = computed(() => users.data.value)
const agentsPayload = computed(() => agents.data.value)
const sessionsPayload = computed(() => sessions.data.value)

const fetchedAtText = computed(() =>
  activeFetchedAt.value == null ? '' : formatDateTime(new Date(activeFetchedAt.value).toISOString())
)

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

// 总览空态不走 TabEmpty，而是给 onboarding 引导（见 OverviewEmpty）
const isOverviewEmpty = computed(() => {
  if (activeTab.value !== 'overview') return false
  const totals = (overview.data.value as OverviewPayload | null)?.periodTotals
  return (totals?.sessions ?? 0) === 0 && (totals?.messages ?? 0) === 0 && (totals?.totalTokens ?? 0) === 0
})

const emptyCopy = computed(() => EMPTY_COPY[activeTab.value as Exclude<TabId, 'overview'>])

function normalizeTab(raw: unknown): TabId {
  const value = String(raw || 'overview')
  return (TABS.some((tab) => tab.value === value) ? value : 'overview') as TabId
}

function normalizeTrendView(raw: unknown): TrendView {
  const value = String(raw || 'traffic')
  return (TREND_VIEWS.includes(value) ? value : 'traffic') as TrendView
}

function currentQuery() {
  const needsLimit = activeTab.value === 'users' || activeTab.value === 'agents'
  const query = buildAnalyticsQuery(period.value, needsLimit ? 20 : undefined)
  // 连通性开关仅属于模型 Tab；其余 Tab 不传该参数，走后端默认口径（排除连通性测试），
  // 避免模型页的勾选状态静默改变其他 Tab 的质量指标
  if (activeTab.value === 'models') {
    query.excludeConnectivity = !includeConnectivity.value
    if (sceneModelId.value != null && Number.isFinite(sceneModelId.value)) {
      query.modelId = sceneModelId.value
    }
  }
  return query
}

async function loadActive(force = false) {
  await activeScope.value.fetchScope(currentQuery(), force)
}

/** tab/period/view/conn/modelId 全部以 URL query 为唯一数据源，同步出去供分享与刷新还原 */
function syncUrl() {
  const nextTab = activeTab.value
  const nextPeriod = periodToQueryValue(period.value)
  const nextView = nextTab === 'trends' ? trendView.value : null
  const nextConn = includeConnectivity.value ? null : '0'
  const nextModelId =
    nextTab === 'models' && sceneModelId.value != null && Number.isFinite(sceneModelId.value)
      ? String(sceneModelId.value)
      : null
  if (
    route.query.tab === nextTab &&
    route.query.period === nextPeriod &&
    (route.query.view ?? null) === nextView &&
    (route.query.conn ?? null) === nextConn &&
    (route.query.modelId ?? null) === nextModelId
  ) {
    return
  }
  const query: Record<string, string> = {
    ...route.query,
    tab: nextTab,
    period: nextPeriod
  }
  if (nextView != null) {
    query.view = nextView
  } else {
    delete query.view
  }
  if (nextConn != null) {
    query.conn = nextConn
  } else {
    delete query.conn
  }
  if (nextModelId != null) {
    query.modelId = nextModelId
  } else {
    delete query.modelId
  }
  router.replace({ query })
}

// ---- UI 事件：v-model 已先改本地状态，必须在此显式加载；route watch 只兜底外部 URL 变化 ----

function handleTabChange() {
  syncUrl()
  void loadActive(false)
}

function handleTrendViewChange(value: TrendView) {
  trendView.value = value
  syncUrl()
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

function handleSceneModelChange(modelId: number | undefined) {
  sceneModelId.value = modelId
  invalidateAnalytics('models')
  syncUrl()
  void loadActive(true)
}

function handleModelsRefresh(include: boolean) {
  includeConnectivity.value = include
  invalidateAnalytics('models')
  syncUrl()
  void loadActive(true)
}

// ---- 浏览器前进/后退、外部分享链接等 URL 直变：由此 watch 驱动状态与加载 ----

watch(
  () => [route.query.tab, route.query.period, route.query.view, route.query.conn, route.query.modelId] as const,
  ([tabValue, periodValue, viewValue, connValue, modelIdValue]) => {
    const nextTab = normalizeTab(tabValue)
    const nextPeriod = periodFromQueryValue(periodValue ?? 'today')
    const nextView = normalizeTrendView(viewValue)
    const nextIncludeConn = connValue !== '0'
    const nextModelId =
      modelIdValue != null && modelIdValue !== '' && Number.isFinite(Number(modelIdValue))
        ? Number(modelIdValue)
        : undefined
    const periodChanged = nextPeriod !== period.value
    const connChanged = nextIncludeConn !== includeConnectivity.value
    const viewChanged = nextView !== trendView.value
    const modelChanged = nextModelId !== sceneModelId.value

    if (periodChanged) {
      period.value = nextPeriod
      invalidateAnalytics()
    }
    if (connChanged) {
      includeConnectivity.value = nextIncludeConn
      if (nextTab === 'models') invalidateAnalytics('models')
    }
    if (modelChanged && nextTab === 'models') {
      sceneModelId.value = nextModelId
      invalidateAnalytics('models')
    }
    if (viewChanged) trendView.value = nextView

    const tabChanged = nextTab !== activeTab.value
    activeTab.value = nextTab

    if (periodChanged || (modelChanged && nextTab === 'models') || (connChanged && nextTab === 'models')) {
      void loadActive(true)
    } else if (tabChanged || !everLoaded) {
      void loadActive(false)
    }
    everLoaded = true
  },
  { immediate: true }
)
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
