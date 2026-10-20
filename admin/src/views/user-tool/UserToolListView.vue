<template>
  <div class="user-tool-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>自定义工具清单</span>
          <div class="header-actions">
            <el-button :loading="loading" @click="loadRecords"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键字">
          <el-input v-model="filters.keyword" clearable placeholder="工具名 / 展示名 / URL" style="width: 220px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="用户名">
          <el-input v-model="filters.username" clearable placeholder="属主用户名" style="width: 160px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="启用态">
          <el-select v-model="filters.enabled" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="已启用" :value="true" />
            <el-option label="已停用" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="records">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="工具名" min-width="150" show-overflow-tooltip />
        <el-table-column prop="displayName" label="展示名" min-width="130" show-overflow-tooltip />
        <el-table-column label="属主" min-width="120">
          <template #default="{ row }">{{ row.username || row.userId }}</template>
        </el-table-column>
        <el-table-column label="端点" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="method-tag" :class="methodClass(row.method)">{{ row.method }}</span>
            {{ row.url }}
          </template>
        </el-table-column>
        <el-table-column label="只读" width="80">
          <template #default="{ row }">
            <el-tag :type="row.readOnly ? 'success' : 'warning'" size="small">{{ row.readOnly ? '只读' : '可写' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="timeoutMs" label="超时(ms)" width="100" />
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
      </el-table>

      <ResponsivePagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="loadRecords"
        @size-change="handleSizeChange"
      />
    </el-card>

    <el-card class="stats-card">
      <template #header>
        <div class="card-header">
          <span>调用统计</span>
          <div class="header-actions">
            <el-input v-model="statsSlug" clearable placeholder="按工具名筛选" style="width: 200px" @keyup.enter="loadStats" @clear="loadStats" />
            <el-button :loading="statsLoading" @click="loadStats"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
      </template>

      <el-alert type="info" :closable="false" class="stats-hint">
        统计来源为运行轨迹中 http_call 的工具调用记录（按内层工具名聚合），仅交互会话产生数据。
      </el-alert>

      <el-table v-loading="statsLoading" :data="stats">
        <el-table-column prop="slug" label="工具名" min-width="180" show-overflow-tooltip />
        <el-table-column prop="calls" label="调用次数" width="110" />
        <el-table-column prop="errors" label="失败次数" width="110" />
        <el-table-column label="失败率" width="100">
          <template #default="{ row }">
            <span :class="{ 'fail-text': row.failRate >= 0.5 }">{{ formatRate(row.failRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="users" label="调用用户数" width="110" />
        <el-table-column label="首次调用" width="170">
          <template #default="{ row }">{{ formatDateTime(row.firstAt) }}</template>
        </el-table-column>
        <el-table-column label="最近调用" width="170">
          <template #default="{ row }">{{ formatDateTime(row.lastAt) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="!statsLoading && stats.length === 0" class="stats-empty">暂无调用记录</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted, reactive, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface UserToolRow {
  id: number
  userId: number
  username: string | null
  name: string
  displayName: string
  description: string
  method: string
  url: string
  readOnly: boolean
  enabled: boolean
  timeoutMs: number
  createdAt: string | null
  updatedAt: string | null
}

interface UserToolStatRow {
  slug: string
  calls: number
  errors: number
  failRate: number
  users: number
  firstAt: string | null
  lastAt: string | null
}

const loading = ref(false)
const records = ref<UserToolRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  keyword: '',
  username: '',
  enabled: '' as '' | boolean
})

const statsLoading = ref(false)
const stats = ref<UserToolStatRow[]>([])
const statsSlug = ref('')

function methodClass(method: string): string {
  const upper = (method || '').toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') return 'method-get'
  if (upper === 'DELETE') return 'method-delete'
  return 'method-write'
}

function formatRate(rate: number): string {
  const value = Number(rate ?? 0) * 100
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function buildParams(page: number, size: number): Record<string, unknown> {
  return {
    page,
    size,
    keyword: filters.keyword.trim() || undefined,
    username: filters.username.trim() || undefined,
    enabled: filters.enabled === '' ? undefined : filters.enabled
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get('/admin/user-tools', { params: buildParams(currentPage.value, pageSize.value) })
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch {
    records.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadStats(): Promise<void> {
  statsLoading.value = true
  try {
    const { data } = await api.get('/admin/user-tools/stats', {
      params: { slug: statsSlug.value.trim() || undefined }
    })
    stats.value = Array.isArray(data) ? data : []
  } catch {
    stats.value = []
  } finally {
    statsLoading.value = false
  }
}

function handleSearch(): void {
  currentPage.value = 1
  void loadRecords()
}

function handleReset(): void {
  filters.keyword = ''
  filters.username = ''
  filters.enabled = ''
  handleSearch()
}

function handleSizeChange(): void {
  currentPage.value = 1
  void loadRecords()
}

onMounted(() => {
  void loadRecords()
  void loadStats()
})

onActivated(() => {
  void loadStats()
})
</script>

<style scoped>
.card-header,
.header-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stats-card {
  margin-top: 16px;
}

.stats-hint {
  margin-bottom: 12px;
}

.stats-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--mao-muted);
  font-size: 13px;
}

.fail-text {
  color: var(--el-color-danger);
  font-weight: 600;
}

.method-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
}

.method-get {
  background: var(--el-fill-color-dark);
  color: var(--mao-muted);
}

.method-write {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.method-delete {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
</style>
