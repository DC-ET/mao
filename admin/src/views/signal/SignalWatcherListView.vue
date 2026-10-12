<template>
  <el-card>
    <template #header>
      <div class="card-header">
        <span>信号哨兵</span>
        <div class="header-actions">
          <el-button :loading="loading" @click="loadRecords"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>
    </template>

    <el-form :inline="true" class="search-form">
      <el-form-item label="状态">
        <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
          <el-option v-for="item in statusOptions" :key="item" :label="statusLabel(item)" :value="item" />
        </el-select>
      </el-form-item>
      <el-form-item label="属主 ID">
        <el-input v-model="filters.userId" clearable style="width: 120px" @keyup.enter="handleSearch" />
      </el-form-item>
      <el-form-item label="判定模式">
        <el-select v-model="filters.compareMode" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
          <el-option v-for="item in compareModeOptions" :key="item" :label="compareModeLabel(item)" :value="item" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="records">
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
      <el-table-column label="属主" min-width="120">
        <template #default="{ row }">{{ row.username || row.userId }}</template>
      </el-table-column>
      <el-table-column label="探测地址" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.method }} {{ row.url }}</template>
      </el-table-column>
      <el-table-column prop="method" label="方法" width="70" />
      <el-table-column prop="intervalMinutes" label="间隔(分)" width="90" />
      <el-table-column label="判定模式" width="110">
        <template #default="{ row }">{{ compareModeLabel(row.compareMode) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="连续失败" width="90">
        <template #default="{ row }">
          <span :class="{ 'fail-text': row.consecutiveFailures > 0 }">{{ row.consecutiveFailures }}</span>
        </template>
      </el-table-column>
      <el-table-column label="上次轮询" width="160">
        <template #default="{ row }">{{ formatDateTime(row.lastCheckedAt) }}</template>
      </el-table-column>
      <el-table-column label="上次变化" width="160">
        <template #default="{ row }">{{ formatDateTime(row.lastChangedAt) }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
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
</template>

<script setup lang="ts">
import { onActivated, onMounted, reactive, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import type { SignalCompareMode, SignalWatcherStatus } from '@mao/contracts'
import { formatDateTime } from '../../utils/datetime'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface WatcherRow {
  id: number
  name: string
  userId: number
  username: string | null
  url: string
  method: string
  intervalMinutes: number
  compareMode: SignalCompareMode
  status: SignalWatcherStatus
  lastCheckedAt: string | null
  lastChangedAt: string | null
  consecutiveFailures: number
  createdAt: string | null
}

const statusOptions: readonly SignalWatcherStatus[] = ['ACTIVE', 'PAUSED', 'DISABLED']
const compareModeOptions: readonly SignalCompareMode[] = ['HASH', 'JSON_FIELD', 'STATUS_CODE']

const STATUS_LABELS: Record<SignalWatcherStatus, string> = {
  ACTIVE: '运行中',
  PAUSED: '已暂停',
  DISABLED: '已停用'
}

const COMPARE_MODE_LABELS: Record<SignalCompareMode, string> = {
  HASH: '内容哈希',
  JSON_FIELD: 'JSON 字段',
  STATUS_CODE: '状态码'
}

const STATUS_TAGS: Record<SignalWatcherStatus, 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  DISABLED: 'danger'
}

const loading = ref(false)
const records = ref<WatcherRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  status: '',
  userId: '',
  compareMode: ''
})

function statusLabel(status: SignalWatcherStatus): string {
  return STATUS_LABELS[status] ?? status
}

function compareModeLabel(mode: SignalCompareMode): string {
  return COMPARE_MODE_LABELS[mode] ?? mode
}

function statusTagType(status: SignalWatcherStatus): 'success' | 'warning' | 'danger' | 'info' {
  return STATUS_TAGS[status] ?? 'info'
}

function buildParams(page: number, size: number): Record<string, unknown> {
  const userId = filters.userId.trim()
  return {
    page,
    size,
    status: filters.status || undefined,
    compareMode: filters.compareMode || undefined,
    userId: userId === '' ? undefined : Number(userId)
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get('/admin/signal-watchers', { params: buildParams(currentPage.value, pageSize.value) })
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch {
    records.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function handleSearch(): void {
  currentPage.value = 1
  void loadRecords()
}

function handleReset(): void {
  filters.status = ''
  filters.userId = ''
  filters.compareMode = ''
  handleSearch()
}

function handleSizeChange(): void {
  currentPage.value = 1
  void loadRecords()
}

onMounted(() => {
  void loadRecords()
})

onActivated(() => {
  void loadRecords()
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

.fail-text {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
