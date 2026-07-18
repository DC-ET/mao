<template>
  <div class="audit-log">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>审计日志</span>
          <el-button @click="fetchLogs">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="动作">
          <el-select v-model="filters.action" clearable placeholder="全部" style="width: 130px">
            <el-option label="READ" value="READ" />
            <el-option label="CREATE" value="CREATE" />
            <el-option label="UPDATE" value="UPDATE" />
            <el-option label="DELETE" value="DELETE" />
          </el-select>
        </el-form-item>
        <el-form-item label="对象">
          <el-input v-model="filters.objectType" clearable placeholder="users / agents" style="width: 160px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="结果">
          <el-select v-model="filters.success" clearable placeholder="全部" style="width: 120px">
            <el-option label="成功" :value="true" />
            <el-option label="失败" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="logs" v-loading="loading" stripe>
        <el-table-column prop="createdAt" label="时间" width="170" />
        <el-table-column prop="username" label="用户" width="120" />
        <el-table-column prop="action" label="动作" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="actionType(row.action)">{{ row.action }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="objectType" label="对象" width="130" />
        <el-table-column prop="method" label="方法" width="90" />
        <el-table-column prop="path" label="路径" min-width="240" show-overflow-tooltip />
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.success === 1 ? 'success' : 'danger'">
              {{ row.success === 1 ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态码" width="90" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
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
        @current-change="fetchLogs"
        @size-change="handleSizeChange"
      />
    </el-card>

    <el-dialog v-model="detailVisible" title="审计详情" width="680px">
      <div class="audit-detail">
      <el-descriptions v-if="currentLog" :column="2" border>
        <el-descriptions-item label="用户">{{ currentLog.username || '-' }}</el-descriptions-item>
        <el-descriptions-item label="IP">{{ currentLog.ip || '-' }}</el-descriptions-item>
        <el-descriptions-item label="动作">{{ currentLog.action }}</el-descriptions-item>
        <el-descriptions-item label="对象">{{ currentLog.objectType }}</el-descriptions-item>
        <el-descriptions-item label="路径" :span="2">{{ currentLog.path }}</el-descriptions-item>
        <el-descriptions-item label="参数" :span="2">{{ currentLog.queryString || '-' }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2">{{ currentLog.errorMessage || '-' }}</el-descriptions-item>
      </el-descriptions>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { api } from '../../api'

const loading = ref(false)
const logs = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const detailVisible = ref(false)
const currentLog = ref<any | null>(null)
const filters = reactive({
  action: '',
  objectType: '',
  success: undefined as boolean | undefined
})

function actionType(action: string) {
  if (action === 'DELETE') return 'danger'
  if (action === 'UPDATE') return 'warning'
  if (action === 'CREATE') return 'success'
  return 'info'
}

async function fetchLogs() {
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.action) params.action = filters.action
    if (filters.objectType) params.objectType = filters.objectType
    if (filters.success !== undefined) params.success = filters.success
    const { data } = await api.get('/audit/logs', { params })
    logs.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchLogs()
}

function handleReset() {
  filters.action = ''
  filters.objectType = ''
  filters.success = undefined
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchLogs()
}

async function showDetail(row: any) {
  const { data } = await api.get(`/audit/logs/${row.id}`)
  currentLog.value = data
  detailVisible.value = true
}

onMounted(fetchLogs)
</script>

<style scoped>
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

.audit-detail :deep(.el-descriptions__content) {
  word-break: break-word;
  overflow-wrap: anywhere;
}

.audit-detail :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
