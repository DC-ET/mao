<template>
  <div class="feedback-view">
    <!-- 汇总指标条：单卡片分隔陈列，避免多卡片拉宽显空 -->
    <el-card class="summary-card">
      <div class="summary-strip">
        <div class="summary-item">
          <div class="summary-label">点踩总数</div>
          <div class="summary-value">{{ summary.total }}</div>
        </div>
        <div v-for="item in summary.byReason" :key="item.reason" class="summary-item">
          <div class="summary-label">{{ item.label }}</div>
          <div class="summary-value">{{ item.count }}</div>
        </div>
      </div>
    </el-card>

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
            <el-option v-for="opt in reasonOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
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
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag :type="row.source === 'feishu' ? 'success' : 'info'" size="small">{{ sourceLabel(row.source) }}</el-tag>
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
            <span class="mobile-card-label">来源</span>
            <span>{{ sourceLabel(row.source) }}</span>
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
        class="pagination"
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
import { computed, onMounted, onActivated, reactive, ref } from 'vue'
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
  source: string
  contentPreview: string | null
  createdAt: string
}

const REASON_TAG_TYPES: Record<string, 'danger' | 'warning' | 'info' | 'primary' | 'success'> = {
  WRONG_RESULT: 'danger',
  SLOW_RESPONSE: 'warning',
  NOT_SOLVED: 'info',
  OTHER: 'primary',
  NO_REASON: 'success'
}

function reasonTagType(reason: string) {
  return REASON_TAG_TYPES[reason] ?? 'info'
}

const SOURCE_LABELS: Record<string, string> = {
  feishu: '飞书',
  desktop: '桌面端'
}

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? '桌面端'
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

/** 原因筛选项由汇总接口 byReason 动态取（含 NO_REASON），不硬编码；空态给占位避免下拉为空。 */
const reasonOptions = computed(() => summary.value.byReason.map((item) => ({ value: item.reason, label: item.label })))

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
  try {
    const { data } = await api.get('/feedback/admin/summary', { params })
    summary.value = {
      total: data?.total ?? 0,
      byReason: data?.byReason ?? [],
      byDay: data?.byDay ?? []
    }
  } catch {
    // 汇总失败不影响明细：保留上一次 byReason，避免原因筛选项与汇总卡被清空
  }
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
  // allSettled：汇总或明细任一失败都不拖垮另一个（原因筛选项由汇总派生，接口抖动不能连带白屏）
  await Promise.allSettled([fetchSummary(), fetchList()])
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
.summary-card {
  margin-bottom: 16px;
}

.summary-card :deep(.el-card__body) {
  padding: 16px 20px;
}

.summary-strip {
  display: flex;
  flex-wrap: wrap;
  row-gap: 12px;
}

.summary-item {
  flex: 1 1 140px;
  min-width: 140px;
  padding: 4px 20px;
  border-left: 1px solid var(--mao-border);
}

.summary-item:first-child {
  border-left: none;
  padding-left: 0;
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

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .summary-item {
    flex-basis: 40%;
    border-left: none;
    padding-left: 0;
  }
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
