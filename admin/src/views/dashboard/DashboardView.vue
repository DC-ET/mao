<template>
  <div class="dashboard" v-loading="loading">
    <div class="page-intro">
      <div>
        <h3>平台健康</h3>
        <p>异常会话点进运行监控；周期报表与 Token 排行见用量分析。</p>
      </div>
      <el-button v-if="canSession" type="primary" link @click="go('/analytics')">查看用量分析</el-button>
    </div>

    <el-row :gutter="20" class="governance-cards">
      <el-col v-for="item in governanceCards" :key="item.label" :xs="24" :sm="12" :md="6">
        <el-card
          shadow="hover"
          :class="{ 'clickable-card': canSession }"
          :role="canSession ? 'button' : undefined"
          :tabindex="canSession ? 0 : undefined"
          @click="canSession && go(item.path, item.query)"
          @keydown.enter="canSession && go(item.path, item.query)"
          @keydown.space.prevent="canSession && go(item.path, item.query)"
        >
          <div class="governance-card" :class="{ danger: item.danger }">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="overview-cards">
      <el-col v-for="item in overviewCards" :key="item.label" :xs="24" :sm="12" :md="6">
        <el-card
          shadow="hover"
          :class="{ 'clickable-card': !!item.path }"
          :role="item.path ? 'button' : undefined"
          :tabindex="item.path ? 0 : undefined"
          @click="item.path && go(item.path)"
          @keydown.enter="item.path && go(item.path)"
          @keydown.space.prevent="item.path && go(item.path)"
        >
          <div class="stat-card">
            <div class="stat-icon"><el-icon size="22"><component :is="item.icon" /></el-icon></div>
            <div class="stat-info">
              <div class="stat-value">{{ item.value }}</div>
              <div class="stat-label">{{ item.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="chart-row">
      <el-col :xs="24" :md="14">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>使用趋势 (近 7 天)</span>
              <el-button v-if="canSession" type="primary" link @click="go('/analytics')">更多周期</el-button>
            </div>
          </template>
          <div v-if="trends.length === 0" class="chart-empty">
            <el-empty description="近 7 天暂无数据" :image-size="80" />
          </div>
          <div v-else class="chart-container">
            <div v-for="day in trends" :key="day.date" class="trend-bar-group">
              <div class="trend-bars">
                <div class="trend-bar sessions" :style="{ height: barHeight(day.sessions, maxSessions) + 'px' }">
                  <el-tooltip :content="`会话: ${day.sessions}`" placement="top">
                    <div class="bar-inner" />
                  </el-tooltip>
                </div>
                <div class="trend-bar messages" :style="{ height: barHeight(day.messages, maxMessages) + 'px' }">
                  <el-tooltip :content="`消息: ${day.messages}`" placement="top">
                    <div class="bar-inner" />
                  </el-tooltip>
                </div>
              </div>
              <div class="trend-label">{{ day.date.slice(5) }}</div>
            </div>
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-dot sessions" />会话</span>
            <span class="legend-item"><span class="legend-dot messages" />消息</span>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card>
          <template #header><span>Agent 使用排行</span></template>
          <div
            v-for="(agent, idx) in agentStats"
            :key="agent.agentId"
            class="rank-item"
            :class="{ clickable: canSession }"
            @click="canSession && go('/sessions', { agentId: String(agent.agentId) })"
          >
            <span class="rank-num" :class="{ top: idx < 3 }">{{ idx + 1 }}</span>
            <span class="rank-name">{{ agent.agentName }}</span>
            <span class="rank-value">{{ agent.sessionCount }} 会话 / {{ agent.messageCount }} 消息</span>
          </div>
          <div v-if="agentStats.length === 0" class="rank-item empty">
            <span class="rank-name">暂无 Agent 使用数据</span>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const overview = ref<any>({})
const trends = ref<any[]>([])
const agentStats = ref<any[]>([])
const loading = ref(false)

const canSession = computed(() => authStore.hasPermission('session:read'))
const canAgent = computed(() => authStore.hasPermission('agent:read'))
const canUser = computed(() => authStore.hasPermission('user:read'))

const maxSessions = computed(() => Math.max(1, ...trends.value.map(d => d.sessions)))
const maxMessages = computed(() => Math.max(1, ...trends.value.map(d => d.messages)))

const governanceCards = computed(() => [
  { label: '运行中会话', value: overview.value.runningSessions || 0, path: '/runtime', query: { phase: 'RUNNING' } },
  { label: '待审批会话', value: overview.value.waitingSessions || 0, path: '/runtime', query: { phase: 'WAITING_APPROVAL' } },
  { label: '失败会话', value: overview.value.failedSessions || 0, path: '/runtime', query: { phase: 'FAILED' }, danger: true },
  { label: '取消会话', value: overview.value.cancelledSessions || 0, path: '/runtime', query: { phase: 'CANCELLED' } }
])

const overviewCards = computed(() => [
  { label: 'Agent 数量', value: overview.value.totalAgents || 0, icon: 'Monitor', path: canAgent.value ? '/agents' : '' },
  { label: '用户数量', value: overview.value.totalUsers || 0, icon: 'User', path: canUser.value ? '/users' : '' },
  { label: '总会话数', value: overview.value.totalSessions || 0, icon: 'ChatDotRound', path: canSession.value ? '/sessions' : '' },
  { label: '总消息数', value: overview.value.totalMessages || 0, icon: 'Comment', path: canSession.value ? '/analytics' : '' }
])

function barHeight(value: number, max: number) {
  return Math.max(4, (value / max) * 120)
}

function go(path: string, query?: Record<string, string>) {
  router.push({ path, query })
}

async function fetchAll() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/analytics/summary', { params: { days: 7 } }) as any
    overview.value = data?.overview || {}
    trends.value = data?.trends || []
    agentStats.value = data?.agentStats || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loading.value = false
  }
}

onMounted(fetchAll)
</script>

<style scoped>
.page-intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.page-intro h3 {
  margin: 0 0 4px;
  font-size: 16px;
  color: var(--mao-ink);
}

.page-intro p {
  margin: 0;
  font-size: 13px;
  color: var(--mao-muted);
}

.clickable-card {
  cursor: pointer;
}

.overview-cards {
  margin-top: 16px;
}

.overview-cards .stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
}

.governance-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.governance-card span {
  color: var(--mao-muted);
}

.governance-card strong {
  font-size: 24px;
  color: var(--mao-ink);
}

.governance-card.danger strong {
  color: #f56c6c;
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mao-accent);
  background: var(--mao-accent-bg);
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--mao-ink);
}

.stat-label {
  font-size: 13px;
  color: var(--mao-muted);
  margin-top: 4px;
}

.chart-row {
  margin-top: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chart-container {
  display: flex;
  align-items: flex-end;
  justify-content: space-around;
  height: 160px;
  padding: 0 10px;
}

.chart-empty {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.trend-bar-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.trend-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 130px;
}

.trend-bar {
  width: 20px;
  display: flex;
  align-items: flex-end;
}

.trend-bar .bar-inner {
  width: 100%;
  height: 100%;
  border-radius: 3px 3px 0 0;
}

.trend-bar.sessions .bar-inner { background: var(--mao-accent); }
.trend-bar.messages .bar-inner { background: var(--el-color-success); }

.trend-label {
  font-size: 11px;
  color: var(--mao-muted);
}

.chart-legend {
  display: flex;
  justify-content: center;
  gap: 20px;
  margin-top: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.legend-dot.sessions { background: var(--mao-accent); }
.legend-dot.messages { background: var(--el-color-success); }

.rank-item {
  display: flex;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--mao-border);
}

.rank-item.clickable {
  cursor: pointer;
}

.rank-item.clickable:hover {
  background: var(--el-fill-color-light);
}

.rank-item.empty {
  color: var(--mao-muted);
}

.rank-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--mao-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--mao-muted);
  margin-right: 12px;
}

.rank-num.top {
  background: var(--mao-accent);
  color: #fff;
}

.rank-name {
  flex: 1;
  font-size: 14px;
}

.rank-value {
  font-size: 12px;
  color: var(--mao-muted);
}

@media (max-width: 768px) {
  .dashboard :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .dashboard :deep(.el-col) {
    max-width: 100%;
    flex: 0 0 100%;
  }

  .overview-cards :deep(.el-col),
  .governance-cards :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }

  .chart-container {
    height: 140px;
  }

  .page-intro {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
