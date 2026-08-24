<template>
  <div class="analytics-view" v-loading="loading">
    <el-card class="toolbar-card">
      <div class="toolbar">
        <div>
          <div class="toolbar-title">周期报表</div>
          <div class="toolbar-hint">按统计周期看阶段、模型与 Token；实时异常请用运行监控。</div>
        </div>
        <div class="toolbar-period">
          <span>统计周期</span>
          <el-segmented v-model="days" :options="periodOptions" @change="fetchSummary" />
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" class="metric-row">
      <el-col :span="6" v-for="item in overviewCards" :key="item.label">
        <el-card
          shadow="hover"
          :class="{ 'clickable-card': !!item.path }"
          @click="go(item.path)"
        >
          <div class="metric" :class="{ danger: item.danger }">
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
          <el-table class="table-scroll" :data="summary.phaseDistribution || []" size="small" stripe>
            <template #empty>
              <el-empty description="暂无数据" :image-size="48" />
            </template>
            <el-table-column label="阶段">
              <template #default="{ row }">{{ phaseLabel(row.phase) }}</template>
            </el-table-column>
            <el-table-column prop="count" label="会话数" align="right" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><span>模型调用</span></template>
          <el-table class="table-scroll" :data="summary.modelStats || []" size="small" stripe>
            <template #empty>
              <el-empty description="暂无数据" :image-size="48" />
            </template>
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
          <el-table class="table-scroll" :data="summary.tokenStats || []" size="small" stripe>
            <template #empty>
              <el-empty description="暂无数据" :image-size="48" />
            </template>
            <el-table-column prop="agentName" label="Agent" />
            <el-table-column prop="totalTokens" label="Token" width="120" align="right" />
            <el-table-column prop="messageCount" label="消息" width="90" align="right" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><span>活跃用户</span></template>
          <el-table class="table-scroll" :data="summary.userActivity || []" size="small" stripe>
            <template #empty>
              <el-empty description="暂无数据" :image-size="48" />
            </template>
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
import { useRouter } from 'vue-router'
import { api } from '../../api'
import { phaseLabel } from '../../utils/labels'

const router = useRouter()
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
    { label: '总会话', value: overview.totalSessions || 0, path: '/sessions' as const },
    { label: '总消息', value: overview.totalMessages || 0, path: '' as const },
    { label: '运行中', value: overview.runningSessions || 0, path: '/runtime?phase=RUNNING' as const },
    { label: '失败会话', value: overview.failedSessions || 0, path: '/runtime?phase=FAILED' as const, danger: true }
  ]
})

function go(path: string) {
  if (path) router.push(path)
}

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
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.toolbar-hint {
  margin-top: 4px;
  font-size: 13px;
  color: #909399;
}

.toolbar-period {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.clickable-card {
  cursor: pointer;
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

.metric.danger strong {
  color: #f56c6c;
}

@media (max-width: 768px) {
  .analytics-view :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .analytics-view :deep(.el-col) {
    max-width: 100%;
    flex: 0 0 100%;
    margin-bottom: 16px;
  }

  .metric-row :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }

  .toolbar {
    flex-wrap: wrap;
  }

  .toolbar-period {
    width: 100%;
  }

  .table-scroll {
    overflow-x: auto;
  }
}
</style>
