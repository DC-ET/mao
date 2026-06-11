<template>
  <div class="session-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>会话管理</span>
        </div>
      </template>

      <!-- Filter form -->
      <el-form :inline="true" class="search-form">
        <el-form-item label="用户">
          <el-select v-model="filters.userId" placeholder="全部用户" clearable filterable style="width: 160px">
            <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Agent">
          <el-select v-model="filters.agentId" placeholder="全部 Agent" clearable filterable style="width: 160px">
            <el-option v-for="a in agentOptions" :key="a.id" :label="a.name" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="执行模式">
          <el-select v-model="filters.executionMode" placeholder="全部" clearable style="width: 120px">
            <el-option label="CLOUD" value="CLOUD" />
            <el-option label="LOCAL" value="LOCAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="任务阶段">
          <el-select v-model="filters.phase" placeholder="全部" clearable style="width: 140px">
            <el-option v-for="p in phaseOptions" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" placeholder="标题/摘要" clearable style="width: 160px" @clear="handleSearch" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <!-- Table -->
      <el-table :data="sessions" stripe v-loading="loading">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column prop="userName" label="用户" width="120" show-overflow-tooltip />
        <el-table-column prop="agentName" label="Agent" width="120" show-overflow-tooltip />
        <el-table-column prop="executionMode" label="执行模式" width="100">
          <template #default="{ row }">
            <el-tag :type="row.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ row.executionMode }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="任务阶段" width="120">
          <template #default="{ row }">
            <el-tag :type="phaseTagType(row.phase)" size="small">{{ row.phase }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="contextTokens" label="上下文Token" width="110" align="right" />
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column prop="lastActivityAt" label="最后活动" width="170" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination -->
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 16px; justify-content: flex-end"
        @current-change="fetchSessions"
        @size-change="handleSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'

const router = useRouter()
const loading = ref(false)
const sessions = ref<any[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const filters = reactive({
  userId: null as number | null,
  agentId: null as number | null,
  executionMode: '' as string,
  phase: '' as string,
  keyword: '' as string
})

const userOptions = ref<Array<{ id: number; username: string; displayName: string }>>([])
const agentOptions = ref<Array<{ id: number; name: string }>>([])

const phaseOptions = [
  { label: 'IDLE', value: 'IDLE' },
  { label: 'RUNNING', value: 'RUNNING' },
  { label: 'COMPLETED', value: 'COMPLETED' },
  { label: 'FAILED', value: 'FAILED' },
  { label: 'CANCELLED', value: 'CANCELLED' }
]

function phaseTagType(phase: string): '' | 'success' | 'danger' | 'warning' | 'info' {
  switch (phase) {
    case 'RUNNING': return ''
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

async function fetchSessions() {
  loading.value = true
  try {
    const params: Record<string, any> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.userId) params.userId = filters.userId
    if (filters.agentId) params.agentId = filters.agentId
    if (filters.executionMode) params.executionMode = filters.executionMode
    if (filters.phase) params.phase = filters.phase
    if (filters.keyword) params.keyword = filters.keyword

    const { data } = await api.get('/admin/sessions', { params })
    sessions.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

async function fetchOptions() {
  const [usersRes, agentsRes] = await Promise.all([
    api.get('/admin/sessions/options/users'),
    api.get('/admin/sessions/options/agents')
  ])
  userOptions.value = usersRes.data || []
  agentOptions.value = agentsRes.data || []
}

function handleSearch() {
  currentPage.value = 1
  fetchSessions()
}

function handleReset() {
  filters.userId = null
  filters.agentId = null
  filters.executionMode = ''
  filters.phase = ''
  filters.keyword = ''
  currentPage.value = 1
  fetchSessions()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchSessions()
}

function handleView(row: any) {
  router.push(`/sessions/${row.id}`)
}

onMounted(() => {
  fetchSessions()
  fetchOptions()
})
</script>

<style scoped>
.session-list {
  width: 100%;
}

.card-header {
  font-size: 16px;
  font-weight: 600;
}

.search-form {
  margin-bottom: 16px;
}

.search-form .el-form-item {
  margin-bottom: 12px;
}
</style>
