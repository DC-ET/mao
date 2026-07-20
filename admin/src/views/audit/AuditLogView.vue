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
          <el-select v-model="filters.action" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
            <el-option
              v-for="opt in AUDIT_ACTION_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="对象">
          <el-input v-model="filters.objectType" clearable placeholder="users / agents" style="width: 160px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="结果">
          <el-select v-model="filters.success" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="成功" :value="true" />
            <el-option label="失败" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="!isMobile" :data="logs" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="createdAt" label="时间" width="170" />
        <el-table-column prop="username" label="用户" width="120" />
        <el-table-column prop="action" label="动作" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="actionType(row.action)">{{ auditActionLabel(row.action) }}</el-tag>
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

      <!-- Mobile card list -->
      <div v-else class="mobile-card-list">
        <el-card v-for="row in logs" :key="row.id" class="audit-card" shadow="hover">
          <div class="audit-card-head">
            <span class="audit-card-action">
              <el-tag size="small" :type="actionType(row.action)">{{ auditActionLabel(row.action) }}</el-tag>
            </span>
            <el-tag size="small" :type="row.success === 1 ? 'success' : 'danger'">
              {{ row.success === 1 ? '成功' : '失败' }}
            </el-tag>
          </div>
          <div class="audit-card-row">
            <span class="audit-card-label">时间</span>
            <span>{{ row.createdAt || '-' }}</span>
          </div>
          <div class="audit-card-row">
            <span class="audit-card-label">用户</span>
            <span>{{ row.username || '-' }}</span>
          </div>
          <div class="audit-card-row">
            <span class="audit-card-label">对象</span>
            <span>{{ row.objectType || '-' }}</span>
          </div>
          <div class="audit-card-row">
            <span class="audit-card-label">路径</span>
            <span class="audit-card-path">{{ row.path || '-' }}</span>
          </div>
          <div class="audit-card-actions">
            <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && logs.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="fetchLogs"
        @size-change="handleSizeChange"
      />
    </el-card>

    <ResponsiveDialog v-if="detailVisible" v-model="detailVisible" title="审计详情" width="680px">
      <div class="audit-detail">
      <el-descriptions v-if="currentLog" :column="2" border>
        <el-descriptions-item label="用户">{{ currentLog.username || '-' }}</el-descriptions-item>
        <el-descriptions-item label="IP">{{ currentLog.ip || '-' }}</el-descriptions-item>
        <el-descriptions-item label="动作">{{ auditActionLabel(currentLog.action) }}</el-descriptions-item>
        <el-descriptions-item label="对象">{{ currentLog.objectType }}</el-descriptions-item>
        <el-descriptions-item label="路径" :span="2">{{ currentLog.path }}</el-descriptions-item>
        <el-descriptions-item label="参数" :span="2">{{ currentLog.queryString || '-' }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2">{{ currentLog.errorMessage || '-' }}</el-descriptions-item>
      </el-descriptions>
      </div>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import { AUDIT_ACTION_OPTIONS, auditActionLabel } from '../../utils/labels'

const { isMobile } = useBreakpoint()
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

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.audit-card {
  font-size: 14px;
}

.audit-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.audit-card-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.5;
}

.audit-card-label {
  width: 40px;
  flex-shrink: 0;
  color: #909399;
}

.audit-card-path {
  word-break: break-all;
}

.audit-card-actions {
  margin-top: 10px;
  border-top: 1px solid #f0f0f0;
  padding-top: 10px;
}
</style>
