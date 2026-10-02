<template>
  <div class="memory-audit-view">
    <el-alert
      class="audit-notice"
      type="info"
      :closable="false"
      show-icon
      title="本页面用于审计用户记忆内容，仅供治理用途"
      description="记忆为用户个人数据，请仅在合规治理需要时查看；本页面为只读，不提供任何修改能力。"
    />

    <el-card>
      <template #header>
        <div class="card-header">
          <span>记忆列表</span>
          <el-button @click="fetchList">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form" @submit.prevent>
        <el-form-item label="用户 ID">
          <el-input
            v-model="userIdInput"
            placeholder="输入用户 ID"
            style="width: 160px"
            clearable
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item label="作用域">
          <el-select v-model="scopeFilter" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
            <el-option label="用户级" value="USER" />
            <el-option label="项目级" value="PROJECT" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
            <el-option label="生效中" value="ACTIVE" />
            <el-option label="已忽略" value="DISMISSED" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!userId" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="items" v-loading="loading" stripe>
        <el-table-column label="ID" prop="id" width="80" />
        <el-table-column label="用户" width="160">
          <template #default="{ row }">
            <span>{{ row.displayName || row.username || `#${row.userId}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="作用域" width="110">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'PROJECT' ? 'warning' : 'info'" size="small">
              {{ row.scope === 'PROJECT' ? '项目' : '用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="项目" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.projectKey || '-' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="280" show-overflow-tooltip>
          <template #default="{ row }">{{ row.content }}</template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag :type="row.source === 'AUTO' ? 'success' : 'info'" size="small">
              {{ row.source === 'AUTO' ? '自动' : '手动' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ row.status === 'ACTIVE' ? '生效中' : '已忽略' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && userId && items.length === 0" description="该用户暂无记忆" />
      <el-empty v-if="!loading && !userId" description="请输入用户 ID 查询" />

      <ResponsivePagination
        class="pagination"
        v-model:currentPage="page"
        :page-size="pageSize"
        :total="total"
        @current-change="fetchList"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface MemoryAuditItem {
  id: number
  userId: number
  username?: string | null
  displayName?: string | null
  scope: string
  projectKey: string | null
  content: string
  source: string
  status: string
  originSessionId: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

const userIdInput = ref('')
const scopeFilter = ref('')
const statusFilter = ref('')
const loading = ref(false)
const items = ref<MemoryAuditItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const userId = computed(() => {
  const parsed = Number(userIdInput.value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
})

function formatDateTime(value?: string | null) {
  if (!value) return '-'
  return String(value).replace('T', ' ').slice(0, 19)
}

async function fetchList() {
  if (!userId.value) {
    items.value = []
    total.value = 0
    return
  }
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      userId: userId.value,
      page: page.value,
      pageSize: pageSize.value
    }
    if (scopeFilter.value) params.scope = scopeFilter.value
    if (statusFilter.value) params.status = statusFilter.value
    const { data } = await api.get('/admin/memory', { params })
    items.value = (data?.records ?? []) as MemoryAuditItem[]
    total.value = data?.total ?? 0
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  void fetchList()
}

function handleReset() {
  userIdInput.value = ''
  scopeFilter.value = ''
  statusFilter.value = ''
  page.value = 1
  items.value = []
  total.value = 0
}

onMounted(() => {
  void fetchList()
})
</script>

<style scoped>
.audit-notice {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.search-form {
  margin-bottom: 4px;
}

.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
