<template>
  <div class="audit-log">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>审计日志</span>
          <div class="header-actions">
            <span class="auto-refresh">
              <span class="auto-refresh-label">自动刷新</span>
              <el-switch v-model="autoRefresh" @change="handleAutoRefreshChange" />
            </span>
            <el-button @click="fetchLogs">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
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
            <el-form-item label="用户">
              <el-select v-model="filters.userId" clearable filterable placeholder="全部" style="width: 160px" @change="handleSearch">
                <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username" :value="u.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="日期">
              <el-date-picker
                v-model="dateRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                style="width: 260px"
                @change="handleSearch"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="对象">
            <el-input v-model="filters.objectType" clearable placeholder="users / agents" style="width: 160px" @keyup.enter="handleSearch" @clear="handleSearch" />
          </el-form-item>
          <el-form-item label="结果">
            <el-select v-model="filters.success" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
              <el-option label="成功" :value="true" />
              <el-option label="失败" :value="false" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="logs" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="createdAt" label="时间" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="username" label="用户" width="120">
          <template #default="{ row }">
            <el-link type="primary" :underline="false" @click="goUserSessions(row)">{{ row.username || '-' }}</el-link>
          </template>
        </el-table-column>
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
            <span>{{ formatDateTime(row.createdAt) }}</span>
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
        <el-descriptions-item label="对象 ID">{{ currentLog.objectId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="路径" :span="2">{{ currentLog.path }}</el-descriptions-item>
        <el-descriptions-item label="参数" :span="2">{{ currentLog.queryString || '-' }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2">{{ currentLog.errorMessage || '-' }}</el-descriptions-item>
      </el-descriptions>
      </div>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import { AUDIT_ACTION_OPTIONS, auditActionLabel } from '../../utils/labels'

const { isMobile } = useBreakpoint()
const router = useRouter()
const loading = ref(false)
const logs = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const detailVisible = ref(false)
const currentLog = ref<any | null>(null)
const userOptions = ref<Array<{ id: number; username: string; displayName?: string | null }>>([])
const dateRange = ref<[string, string] | null>(null)
const autoRefresh = ref(false)
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null
const AUTO_REFRESH_INTERVAL_MS = 60_000

const filters = reactive({
  action: '',
  objectType: '',
  success: undefined as boolean | undefined,
  userId: undefined as number | undefined
})

async function fetchOptions() {
  try {
    const { data } = await api.get('/admin/sessions/options/users')
    userOptions.value = data || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ }
}

function goUserSessions(row: { userId?: number | null }) {
  if (row.userId == null) return
  router.push({ path: '/sessions', query: { userId: String(row.userId) } })
}

function handleAutoRefreshChange(enabled: string | number | boolean) {
  if (enabled) {
    startAutoRefresh()
  } else {
    stopAutoRefresh()
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  autoRefreshTimer = setInterval(() => fetchLogs(), AUTO_REFRESH_INTERVAL_MS)
}

function stopAutoRefresh() {
  if (autoRefreshTimer != null) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
}

function actionType(action: string) {
  if (action === 'DELETE') return 'danger'
  if (action === 'UPDATE') return 'warning'
  if (action === 'CREATE') return 'success'
  return 'info'
}

let fetchLogsSeq = 0
async function fetchLogs() {
  const seq = ++fetchLogsSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.action) params.action = filters.action
    if (filters.objectType) params.objectType = filters.objectType
    if (filters.success !== undefined) params.success = filters.success
    if (filters.userId != null) params.userId = filters.userId
    if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
    if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
    const { data } = await api.get('/audit/logs', { params })
    if (seq !== fetchLogsSeq) return
    logs.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchLogsSeq) loading.value = false
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
  filters.userId = undefined
  dateRange.value = null
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchLogs()
}

async function showDetail(row: any) {
  try {
    const { data } = await api.get(`/audit/logs/${row.id}`)
    currentLog.value = data
    detailVisible.value = true
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ }
}

onMounted(() => {
  fetchOptions()
  fetchLogs()
})

onDeactivated(stopAutoRefresh)

// 本页 keepAlive: true，切走只 deactivate。必须在回来时按开关状态重启定时器，
// 否则开关仍显示开启但列表再也不刷新，用户会以为自己在盯实时审计。
onActivated(() => {
  if (autoRefresh.value) {
    startAutoRefresh()
    fetchLogs()
  }
})

onBeforeUnmount(stopAutoRefresh)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.auto-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.auto-refresh-label {
  font-size: 13px;
  color: var(--mao-muted);
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
  color: var(--mao-muted);
}

.audit-card-path {
  word-break: break-all;
}

.audit-card-actions {
  margin-top: 10px;
  border-top: 1px solid var(--mao-border);
  padding-top: 10px;
}
</style>
