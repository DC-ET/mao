<template>
  <div class="feedback-view">
    <!-- 汇总卡片 -->
    <el-row :gutter="16" class="summary-row">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card class="summary-card">
          <div class="summary-label">点踩总数</div>
          <div class="summary-value">{{ summary.total }}</div>
        </el-card>
      </el-col>
      <el-col v-for="item in summary.byReason" :key="item.reason" :xs="24" :sm="12" :md="6">
        <el-card class="summary-card">
          <div class="summary-label">{{ item.label }}</div>
          <div class="summary-value">{{ item.count }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 明细列表 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>点踩明细</span>
          <div class="header-actions">
            <el-button @click="fetchList">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="原因">
          <el-select v-model="filters.reason" clearable placeholder="全部" style="width: 150px" @change="handleSearch">
            <el-option v-for="opt in REASON_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            style="width: 240px"
            @change="handleSearch"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="!isMobile" :data="items" v-loading="loading" stripe>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="用户" min-width="120">
          <template #default="{ row }">{{ userLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="会话" width="100">
          <template #default="{ row }">
            <el-button type="primary" link @click="goSession(row.sessionId)">{{ row.sessionId }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="120">
          <template #default="{ row }">{{ agentLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="原因" width="120">
          <template #default="{ row }">
            <el-tag :type="reasonTagType(row.reason)" size="small">{{ row.reasonLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="消息内容" min-width="280" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.contentPreview">{{ row.contentPreview }}</span>
            <span v-else class="content-missing">（消息已不存在）</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in items" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <el-tag :type="reasonTagType(row.reason)" size="small">{{ row.reasonLabel }}</el-tag>
            <span class="feedback-card-time">{{ formatDateTime(row.createdAt) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ userLabel(row) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">会话</span>
            <el-button type="primary" link @click="goSession(row.sessionId)">{{ row.sessionId }}</el-button>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Agent</span>
            <span>{{ agentLabel(row) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">消息</span>
            <span v-if="row.contentPreview" class="feedback-card-preview">{{ row.contentPreview }}</span>
            <span v-else class="content-missing">（消息已不存在）</span>
          </div>
        </el-card>
        <el-empty v-if="!loading && items.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        v-model:currentPage="page"
        v-model:page-size="pageSize"
        :total="total"
        @current-change="fetchList"
        @size-change="handleSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onActivated, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface FeedbackSummaryItem {
  reason: string
  label: string
  count: number
}

interface FeedbackSummary {
  total: number
  byReason: FeedbackSummaryItem[]
  byDay: Array<{ date: string; count: number }>
}

interface FeedbackDetailItem {
  id: number
  messageId: number
  sessionId: number
  userId: number
  username: string | null
  displayName: string | null
  agentId: number | null
  agentName: string | null
  reason: string
  reasonLabel: string
  contentPreview: string | null
  createdAt: string
}

const REASON_OPTIONS = [
  { value: 'WRONG_RESULT', label: '结果错误' },
  { value: 'SLOW_RESPONSE', label: '处理速度慢' },
  { value: 'NOT_SOLVED', label: '问题未解决' },
  { value: 'OTHER', label: '其他' }
]

const REASON_TAG_TYPES: Record<string, 'danger' | 'warning' | 'info' | 'primary'> = {
  WRONG_RESULT: 'danger',
  SLOW_RESPONSE: 'warning',
  NOT_SOLVED: 'info',
  OTHER: 'primary'
}

function reasonTagType(reason: string) {
  return REASON_TAG_TYPES[reason] ?? 'info'
}

const router = useRouter()
const { isMobile } = useBreakpoint()

function userLabel(row: FeedbackDetailItem) {
  return row.displayName || row.username || `用户 #${row.userId}`
}

function agentLabel(row: FeedbackDetailItem) {
  return row.agentName || (row.agentId != null ? `#${row.agentId}` : '-')
}

function goSession(sessionId: number) {
  router.push(`/sessions/${sessionId}`)
}

const summary = ref<FeedbackSummary>({ total: 0, byReason: [], byDay: [] })
const items = ref<FeedbackDetailItem[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filters = reactive<{ reason?: string }>({})
const dateRange = ref<[string, string] | null>(null)

function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {
    page: page.value,
    pageSize: pageSize.value
  }
  if (filters.reason) params.reason = filters.reason
  if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
  if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
  return params
}

async function fetchSummary() {
  const params: Record<string, unknown> = {}
  if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
  if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
  const { data } = await api.get('/feedback/admin/summary', { params })
  summary.value = data ?? { total: 0, byReason: [], byDay: [] }
}

async function fetchList() {
  loading.value = true
  try {
    const { data } = await api.get('/feedback/admin/list', { params: buildParams() })
    items.value = data?.items ?? []
    total.value = data?.total ?? 0
  } finally {
    loading.value = false
  }
}

async function refreshAll() {
  await Promise.all([fetchSummary(), fetchList()])
}

function handleSearch() {
  page.value = 1
  refreshAll()
}

function handleSizeChange() {
  page.value = 1
  fetchList()
}

function handleReset() {
  filters.reason = undefined
  dateRange.value = null
  page.value = 1
  refreshAll()
}

let firstActivation = true
onMounted(refreshAll)
onActivated(() => {
  if (firstActivation) {
    firstActivation = false
    return
  }
  refreshAll()
})
</script>

<style scoped>
.summary-row {
  margin-bottom: 16px;
}

.summary-card :deep(.el-card__body) {
  padding: 16px 20px;
}

.summary-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.summary-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-form {
  margin-bottom: 12px;
}

.content-missing {
  color: var(--el-text-color-placeholder);
  font-style: italic;
}

.feedback-card-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--mao-muted);
}

.feedback-card-preview {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
