<template>
  <div class="runtime-monitor">
    <el-row :gutter="16" class="metric-row">
      <el-col :span="6" v-for="item in metrics" :key="item.label">
        <el-card>
          <div class="metric">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>运行中与异常会话</span>
          <el-button @click="fetchSessions">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="执行模式">
          <el-select v-model="filters.executionMode" clearable placeholder="全部" style="width: 130px">
            <el-option label="CLOUD" value="CLOUD" />
            <el-option label="LOCAL" value="LOCAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="阶段">
          <el-select v-model="filters.phase" clearable placeholder="重点状态" style="width: 160px">
            <el-option label="RUNNING" value="RUNNING" />
            <el-option label="WAITING_APPROVAL" value="WAITING_APPROVAL" />
            <el-option label="FAILED" value="FAILED" />
            <el-option label="CANCELLED" value="CANCELLED" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" clearable placeholder="标题/摘要" style="width: 180px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="sessions" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" class="hide-on-mobile" />
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column prop="userName" label="用户" width="120" />
        <el-table-column prop="agentName" label="Agent" width="130" class="hide-on-mobile" />
        <el-table-column prop="executionMode" label="模式" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.executionMode === 'LOCAL' ? 'warning' : 'primary'">
              {{ row.executionMode }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="阶段" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="phaseTag(row.phase)">{{ row.phase }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="contextTokens" label="上下文 Token" width="130" align="right" class="hide-on-mobile" />
        <el-table-column prop="lastActivityAt" label="最后活动" width="170" class="hide-on-mobile" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="router.push(`/sessions/${row.id}`)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="fetchSessions"
        @size-change="handleSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'

const router = useRouter()
const loading = ref(false)
const sessions = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  executionMode: '',
  phase: '',
  keyword: ''
})

const metrics = computed(() => [
  { label: '重点会话(当前页)', value: sessions.value.length },
  { label: '运行中(当前页)', value: sessions.value.filter(s => s.phase === 'RUNNING').length },
  { label: '待审批(当前页)', value: sessions.value.filter(s => s.phase === 'WAITING_APPROVAL').length },
  { label: '失败/取消(当前页)', value: sessions.value.filter(s => ['FAILED', 'CANCELLED'].includes(s.phase)).length }
])

function phaseTag(phase: string) {
  if (phase === 'FAILED') return 'danger'
  if (phase === 'CANCELLED' || phase === 'WAITING_APPROVAL') return 'warning'
  if (phase === 'COMPLETED') return 'success'
  return 'primary'
}

async function fetchSessions() {
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.executionMode) params.executionMode = filters.executionMode
    if (filters.phase) params.phase = filters.phase
    if (filters.keyword) params.keyword = filters.keyword
    const { data } = await api.get('/admin/runtime/sessions', { params })
    sessions.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchSessions()
}

function handleReset() {
  filters.executionMode = ''
  filters.phase = ''
  filters.keyword = ''
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchSessions()
}

onMounted(fetchSessions)
onActivated(fetchSessions)
</script>

<style scoped>
.metric-row {
  margin-bottom: 16px;
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

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .runtime-monitor :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .runtime-monitor :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }
}
</style>
