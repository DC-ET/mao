<template>
  <div class="analytics-view" v-loading="loading">
    <el-card class="toolbar-card">
      <div class="toolbar">
        <span>统计周期</span>
        <el-segmented v-model="days" :options="periodOptions" @change="fetchSummary" />
      </div>
    </el-card>

    <el-row :gutter="16" class="metric-row">
      <el-col :span="6" v-for="item in overviewCards" :key="item.label">
        <el-card>
          <div class="metric">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card>
          <template #header><span>阶段分布</span></template>
          <el-table :data="summary.phaseDistribution || []" size="small" stripe>
            <el-table-column prop="phase" label="阶段" />
            <el-table-column prop="count" label="会话数" align="right" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><span>模型调用</span></template>
          <el-table :data="summary.modelStats || []" size="small" stripe>
            <el-table-column prop="modelName" label="模型" min-width="140" />
            <el-table-column prop="messageCount" label="消息" width="90" align="right" />
            <el-table-column prop="sessionCount" label="会话" width="90" align="right" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="12">
        <el-card>
          <template #header><span>Token 消耗排行</span></template>
          <el-table :data="summary.tokenStats || []" size="small" stripe>
            <el-table-column prop="agentName" label="Agent" />
            <el-table-column prop="totalTokens" label="Token" width="120" align="right" />
            <el-table-column prop="messageCount" label="消息" width="90" align="right" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><span>活跃用户</span></template>
          <el-table :data="summary.userActivity || []" size="small" stripe>
            <el-table-column prop="displayName" label="用户" />
            <el-table-column prop="sessionCount" label="会话" width="90" align="right" />
            <el-table-column prop="messageCount" label="消息" width="90" align="right" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { api } from '../../api'

const days = ref(30)
const loading = ref(false)
const periodOptions = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 }
]
const summary = ref<any>({})

const overviewCards = computed(() => {
  const overview = summary.value.overview || {}
  return [
    { label: '总会话', value: overview.totalSessions || 0 },
    { label: '总消息', value: overview.totalMessages || 0 },
    { label: '运行中', value: overview.runningSessions || 0 },
    { label: '失败会话', value: overview.failedSessions || 0 }
  ]
})

async function fetchSummary() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/analytics/summary', { params: { days: days.value } })
    summary.value = data || {}
  } finally {
    loading.value = false
  }
}

onMounted(fetchSummary)
</script>

<style scoped>
.toolbar-card,
.metric-row {
  margin-bottom: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.metric {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.metric span {
  color: #606266;
}

.metric strong {
  font-size: 24px;
  color: #303133;
}
</style>
