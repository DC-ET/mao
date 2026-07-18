<template>
  <div class="dashboard" v-loading="loading">
    <!-- Overview Cards -->
    <el-row :gutter="20" class="overview-cards">
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-icon" style="background: #409eff"><el-icon size="28"><Monitor /></el-icon></div>
            <div class="stat-info">
              <div class="stat-value">{{ overview.totalAgents || 0 }}</div>
              <div class="stat-label">Agent 数量</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-icon" style="background: #67c23a"><el-icon size="28"><User /></el-icon></div>
            <div class="stat-info">
              <div class="stat-value">{{ overview.totalUsers || 0 }}</div>
              <div class="stat-label">用户数量</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-icon" style="background: #e6a23c"><el-icon size="28"><ChatDotRound /></el-icon></div>
            <div class="stat-info">
              <div class="stat-value">{{ overview.totalSessions || 0 }}</div>
              <div class="stat-label">总会话数</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-icon" style="background: #f56c6c"><el-icon size="28"><Comment /></el-icon></div>
            <div class="stat-info">
              <div class="stat-value">{{ overview.totalMessages || 0 }}</div>
              <div class="stat-label">总消息数</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="governance-cards">
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="governance-card">
            <span>运行中会话</span>
            <strong>{{ governance.runningSessions || 0 }}</strong>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="governance-card">
            <span>待审批会话</span>
            <strong>{{ governance.waitingSessions || 0 }}</strong>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="governance-card danger">
            <span>失败会话</span>
            <strong>{{ governance.failedSessions || 0 }}</strong>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div class="governance-card">
            <span>取消会话</span>
            <strong>{{ governance.cancelledSessions || 0 }}</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Charts Row -->
    <el-row :gutter="20" style="margin-top: 20px">
      <!-- Usage Trends -->
      <el-col :span="14">
        <el-card>
          <template #header><span>使用趋势 (近 7 天)</span></template>
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

      <!-- Agent Stats -->
      <el-col :span="10">
        <el-card>
          <template #header><span>Agent 使用排行</span></template>
          <div v-for="(agent, idx) in agentStats" :key="agent.agentId" class="rank-item">
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

    <!-- Token & User Stats -->
    <el-row :gutter="20" style="margin-top: 20px">
      <el-col :span="12">
        <el-card>
          <template #header><span>Token 消耗排行</span></template>
          <el-table :data="tokenStats" stripe size="small">
            <el-table-column prop="agentName" label="Agent" />
            <el-table-column prop="totalTokens" label="Token 总量" width="120">
              <template #default="{ row }">{{ row.totalTokens.toLocaleString() }}</template>
            </el-table-column>
            <el-table-column prop="messageCount" label="消息数" width="100" />
          </el-table>
          <el-empty v-if="tokenStats.length === 0" description="暂无数据" :image-size="60" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><span>用户活跃度</span></template>
          <el-table :data="userStats" stripe size="small">
            <el-table-column prop="displayName" label="用户" />
            <el-table-column prop="sessionCount" label="会话数" width="100" />
            <el-table-column prop="messageCount" label="消息数" width="100" />
            <el-table-column prop="lastLoginAt" label="最后登录" width="180" />
          </el-table>
          <el-empty v-if="userStats.length === 0" description="暂无数据" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '../../api'

const overview = ref<any>({})
const governance = ref<any>({})
const trends = ref<any[]>([])
const agentStats = ref<any[]>([])
const tokenStats = ref<any[]>([])
const userStats = ref<any[]>([])
const loading = ref(false)

const maxSessions = computed(() => Math.max(1, ...trends.value.map(d => d.sessions)))
const maxMessages = computed(() => Math.max(1, ...trends.value.map(d => d.messages)))

function barHeight(value: number, max: number) {
  return Math.max(4, (value / max) * 120)
}

async function fetchAll() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/analytics/summary', { params: { days: 7 } }) as any
    overview.value = data?.overview || {}
    governance.value = overview.value
    trends.value = data?.trends || []
    tokenStats.value = data?.tokenStats || []
    userStats.value = data?.userActivity || []
    agentStats.value = data?.agentStats || []
  } finally {
    loading.value = false
  }
}

onMounted(fetchAll)
</script>

<style scoped>
.overview-cards .stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
}

.governance-cards {
  margin-top: 20px;
}

.governance-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.governance-card span {
  color: #606266;
}

.governance-card strong {
  font-size: 24px;
  color: #303133;
}

.governance-card.danger strong {
  color: #f56c6c;
}

.stat-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: #303133;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
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

.trend-bar.sessions .bar-inner { background: #409eff; }
.trend-bar.messages .bar-inner { background: #67c23a; }

.trend-label {
  font-size: 11px;
  color: #909399;
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
  color: #606266;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.legend-dot.sessions { background: #409eff; }
.legend-dot.messages { background: #67c23a; }

.rank-item {
  display: flex;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.rank-item.empty {
  color: #909399;
}

.rank-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: #909399;
  margin-right: 12px;
}

.rank-num.top {
  background: #409eff;
  color: #fff;
}

.rank-name {
  flex: 1;
  font-size: 14px;
}

.rank-value {
  font-size: 12px;
  color: #909399;
}

@media (max-width: 768px) {
  /* Charts/table rows collapse to a single column */
  .dashboard :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .dashboard :deep(.el-col) {
    max-width: 100%;
    flex: 0 0 100%;
  }

  /* Keep the small metric/stat cards in a 2-column grid */
  .overview-cards :deep(.el-col),
  .governance-cards :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }

  .chart-container {
    height: 140px;
  }
}
</style>
