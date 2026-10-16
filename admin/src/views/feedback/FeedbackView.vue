<template>
  <div class="feedback-view">
    <!-- 汇总指标条：点踩总数 + 待处理数 + 各原因计数（单卡片分隔陈列） -->
    <el-card class="summary-card">
      <div class="summary-strip">
        <div class="summary-item">
          <div class="summary-label">点踩总数</div>
          <div class="summary-value">{{ summary.total }}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">待处理</div>
          <div class="summary-value" :class="{ 'summary-value-alert': summary.pendingCount > 0 }">
            {{ summary.pendingCount }}
          </div>
        </div>
        <div v-for="item in summary.byReason" :key="item.reason" class="summary-item">
          <div class="summary-label">{{ item.label }}</div>
          <div class="summary-value">{{ item.count }}</div>
        </div>
      </div>
    </el-card>

    <!-- 待处理矩阵：Agent × 原因，点击单元格联动明细筛选 -->
    <el-card v-if="!isMobile && matrixRows.length > 0" class="matrix-card">
      <template #header>
        <div class="card-header">
          <span>待处理分布（Agent × 原因）</span>
          <span class="matrix-hint">点击单元格筛选该 Agent 的待处理反馈</span>
        </div>
      </template>
      <el-table :data="matrixRows" size="small" class="matrix-table" @row-click="handleMatrixRow">
        <el-table-column label="Agent" min-width="140">
          <template #default="{ row }">
            <span v-if="row.agentId == null" class="matrix-no-agent">无 Agent（飞书）</span>
            <span v-else>{{ row.agentName || `#${row.agentId}` }}</span>
          </template>
        </el-table-column>
        <el-table-column v-for="reason in reasonOptions" :key="reason.value" :label="reason.label" min-width="110" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.counts[reason.value] > 0"
              type="primary"
              link
              class="matrix-cell"
              @click.stop="applyMatrixFilter(row.agentId, reason.value)"
            >
              {{ row.counts[reason.value] }}
            </el-button>
            <span v-else class="matrix-empty">-</span>
          </template>
        </el-table-column>
        <el-table-column label="合计" width="90" align="center">
          <template #default="{ row }">{{ row.total }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 明细列表 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>点踩明细</span>
          <div class="header-actions">
            <span v-if="canWrite && selectedIds.length > 0" class="batch-bar">
              已选 {{ selectedIds.length }} 条
              <el-button size="small" @click="handleBatchDismiss">忽略</el-button>
              <el-button link size="small" @click="clearSelection">取消选择</el-button>
            </span>
            <el-button @click="fetchList">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="状态">
          <el-select v-model="filters.status" placeholder="待处理" style="width: 140px" @change="handleSearch">
            <el-option label="待处理" value="PENDING" />
            <el-option label="已转经验" value="CONVERTED" />
            <el-option label="已忽略" value="DISMISSED" />
            <el-option label="全部" :value="undefined" />
          </el-select>
        </el-form-item>
        <el-form-item label="Agent">
          <el-select v-model="filters.agentId" clearable filterable placeholder="全部" style="width: 170px" @change="handleSearch">
            <el-option v-for="opt in agentOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
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

      <el-table
        v-if="!isMobile"
        ref="tableRef"
        :data="items"
        v-loading="loading"
        stripe
        row-key="id"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" :selectable="isRowSelectable" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="用户" min-width="120">
          <template #default="{ row }">{{ userLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="会话" width="100">
          <template #default="{ row }">
            <el-button type="primary" link @click="goSession(row.sessionId)">{{ row.sessionId }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="140">
          <template #default="{ row }">
            {{ agentLabel(row) }}
            <el-tooltip v-if="row.sameGroupCount > 1" effect="dark" placement="top">
              <template #content>同 Agent 同原因的待处理反馈共 {{ row.sameGroupCount }} 条</template>
              <el-tag type="info" size="small" class="group-tag">同类 {{ row.sameGroupCount }} 条</el-tag>
            </el-tooltip>
          </template>
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
        <el-table-column label="消息内容" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.contentPreview">{{ row.contentPreview }}</span>
            <span v-else class="content-missing">（消息已不存在）</span>
          </template>
        </el-table-column>
        <el-table-column label="处理信息" min-width="120">
          <template #default="{ row }">
            <span v-if="row.status === 'CONVERTED' && row.experienceId != null" class="handled-info">
              经验 #{{ row.experienceId }}
            </span>
            <span v-else-if="row.handledByName" class="handled-info">{{ row.handledByName }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'PENDING'">
              <el-button v-if="canWrite" type="danger" link @click="handleDismiss(row)">忽略</el-button>
              <span v-if="!canWrite" class="readonly-hint">只读</span>
            </template>
            <el-button v-else-if="row.status === 'CONVERTED'" type="info" link disabled>已转经验</el-button>
            <el-button v-else type="info" link disabled>已忽略</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in items" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <el-tag :type="reasonTagType(row.reason)" size="small">{{ row.reasonLabel }}</el-tag>
            <el-tag :type="statusTagType(row.status)" size="small" class="mobile-status">{{ statusLabel(row.status) }}</el-tag>
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
            <span>
              {{ agentLabel(row) }}
              <el-tag v-if="row.sameGroupCount > 1" type="info" size="small" class="group-tag">同类 {{ row.sameGroupCount }} 条</el-tag>
            </span>
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
          <div v-if="row.status === 'CONVERTED' && row.experienceId != null" class="mobile-card-row">
            <span class="mobile-card-label">经验</span>
            <span>#{{ row.experienceId }}</span>
          </div>
          <div v-if="canWrite && row.status === 'PENDING'" class="mobile-card-actions">
            <el-button type="danger" size="small" link @click="handleDismiss(row)">忽略</el-button>
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
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import type { FeedbackReason, FeedbackSource, FeedbackStatus } from '@mao/contracts'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface FeedbackSummaryItem {
  reason: FeedbackReason
  label: string
  count: number
}

interface PendingMatrixItem {
  agentId: number | null
  agentName: string | null
  reason: FeedbackReason
  reasonLabel: string
  count: number
}

interface FeedbackSummary {
  total: number
  byReason: FeedbackSummaryItem[]
  byDay: Array<{ date: string; count: number }>
  pendingCount: number
  pendingMatrix: PendingMatrixItem[]
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
  reason: FeedbackReason
  reasonLabel: string
  source: FeedbackSource
  status: FeedbackStatus
  handledByName: string | null
  experienceId: number | null
  sameGroupCount: number
  contentPreview: string | null
  createdAt: string
}

interface AgentOption {
  value: number
  label: string
}

const REASON_TAG_TYPES: Record<FeedbackReason, 'danger' | 'warning' | 'info' | 'primary' | 'success'> = {
  WRONG_RESULT: 'danger',
  SLOW_RESPONSE: 'warning',
  NOT_SOLVED: 'info',
  OTHER: 'primary',
  NO_REASON: 'success'
}

function reasonTagType(reason: FeedbackReason) {
  return REASON_TAG_TYPES[reason] ?? 'info'
}

const SOURCE_LABELS: Record<FeedbackSource, string> = {
  feishu: '飞书',
  desktop: '桌面端'
}

function sourceLabel(source: FeedbackSource) {
  return SOURCE_LABELS[source] ?? '桌面端'
}

const STATUS_TAG_TYPES: Record<FeedbackStatus, 'warning' | 'success' | 'info'> = {
  PENDING: 'warning',
  CONVERTED: 'success',
  DISMISSED: 'info'
}

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  PENDING: '待处理',
  CONVERTED: '已转经验',
  DISMISSED: '已忽略'
}

function statusTagType(status: FeedbackStatus) {
  return STATUS_TAG_TYPES[status] ?? 'warning'
}

function statusLabel(status: FeedbackStatus) {
  return STATUS_LABELS[status] ?? status
}

const router = useRouter()
const { isMobile } = useBreakpoint()
const authStore = useAuthStore()

/** 写操作（忽略）门槛与后端 feedback:write 一致：只读账号看不到入口，避免点了才报 403。 */
const canWrite = computed(() => authStore.hasPermission('feedback:write'))

function userLabel(row: FeedbackDetailItem) {
  return row.displayName || row.username || `用户 #${row.userId}`
}

function agentLabel(row: FeedbackDetailItem) {
  return row.agentName || (row.agentId != null ? `#${row.agentId}` : '-')
}

function goSession(sessionId: number) {
  router.push(`/sessions/${sessionId}`)
}

const summary = ref<FeedbackSummary>({ total: 0, byReason: [], byDay: [], pendingCount: 0, pendingMatrix: [] })
const items = ref<FeedbackDetailItem[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filters = reactive<{ status?: FeedbackStatus; agentId?: number; reason?: FeedbackReason }>({ status: 'PENDING' })
const dateRange = ref<[string, string] | null>(null)
const agentOptions = ref<AgentOption[]>([])

/** 原因筛选项由汇总接口 byReason 动态取（含 NO_REASON），不硬编码；空态给占位避免下拉为空。 */
const reasonOptions = computed(() => summary.value.byReason.map((item) => ({ value: item.reason, label: item.label })))

/** 矩阵行：按 Agent 聚合成一行，每列是对应原因的待处理数（单元格可点击下钻）。 */
const matrixRows = computed(() => {
  const byAgent = new Map<number | null, { counts: Partial<Record<FeedbackReason, number>>; total: number }>()
  const nameByAgent = new Map<number | null, string | null>()
  for (const cell of summary.value.pendingMatrix) {
    if (!byAgent.has(cell.agentId)) byAgent.set(cell.agentId, { counts: {}, total: 0 })
    const entry = byAgent.get(cell.agentId)!
    entry.counts[cell.reason] = cell.count
    entry.total += cell.count
    nameByAgent.set(cell.agentId, cell.agentName)
  }
  return [...byAgent.entries()]
    .map(([agentId, entry]) => ({ agentId, agentName: nameByAgent.get(agentId) ?? null, ...entry }))
    .sort((a, b) => b.total - a.total)
})

function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {
    page: page.value,
    pageSize: pageSize.value
  }
  if (filters.status) params.status = filters.status
  if (filters.agentId != null) params.agentId = filters.agentId
  if (filters.reason) params.reason = filters.reason
  if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
  if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
  return params
}

async function fetchAgents() {
  try {
    const { data } = await api.get('/agents', { params: { includeDisabled: true } })
    agentOptions.value = (data ?? []).map((agent: { id: number; name: string }) => ({ value: agent.id, label: agent.name }))
  } catch {
    // Agent 下拉失败只影响筛选，不阻断页面其余部分
  }
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
      byDay: data?.byDay ?? [],
      pendingCount: data?.pendingCount ?? 0,
      pendingMatrix: data?.pendingMatrix ?? []
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
  } catch {
    // 拦截器已提示失败；fetchList 被模板分页事件直接调用，必须吞掉 rejection
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
  clearSelection()
  refreshAll()
}

function handleSizeChange() {
  page.value = 1
  fetchList()
}

function handleReset() {
  filters.status = 'PENDING'
  filters.agentId = undefined
  filters.reason = undefined
  dateRange.value = null
  page.value = 1
  clearSelection()
  refreshAll()
}

/** 单元格点击：下钻到该 Agent + 该原因的待处理反馈。 */
function applyMatrixFilter(agentId: number | null, reason: FeedbackReason) {
  filters.status = 'PENDING'
  filters.reason = reason
  filters.agentId = agentId ?? undefined
  page.value = 1
  clearSelection()
  fetchList()
}

/** 整行点击：看该 Agent 的全部待处理反馈（agentId 为 null 即飞书来源的无 Agent 行）。 */
function handleMatrixRow(row: { agentId: number | null }) {
  filters.status = 'PENDING'
  filters.reason = undefined
  filters.agentId = row.agentId ?? undefined
  page.value = 1
  clearSelection()
  fetchList()
}

const selectedIds = ref<number[]>([])
const selectedRows = ref<FeedbackDetailItem[]>([])

function isRowSelectable(row: FeedbackDetailItem) {
  // 终态行不可勾选：混批已处理行会让整批忽略失败，从入口就拦掉
  return row.status === 'PENDING'
}

function handleSelectionChange(rows: FeedbackDetailItem[]) {
  selectedRows.value = rows
  selectedIds.value = rows.map((row) => row.id)
}

function clearSelection() {
  selectedRows.value = []
  selectedIds.value = []
}

async function handleDismiss(row: FeedbackDetailItem) {
  try {
    await ElMessageBox.confirm('确定忽略这条反馈吗？忽略后不可恢复。', '忽略反馈', { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.post('/feedback/admin/dismiss', { feedbackIds: [row.id] })
    ElMessage.success('已忽略')
    clearSelection()
    await refreshAll()
  } catch {
    // 拦截器已提示失败
  }
}

async function handleBatchDismiss() {
  if (selectedIds.value.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定忽略已选的 ${selectedIds.value.length} 条反馈吗？忽略后不可恢复。`,
      '批量忽略',
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await api.post('/feedback/admin/dismiss', { feedbackIds: selectedIds.value })
    ElMessage.success(`已忽略 ${selectedIds.value.length} 条反馈`)
    clearSelection()
    await refreshAll()
  } catch {
    // 拦截器已提示失败
  }
}

let firstActivation = true
onMounted(() => {
  fetchAgents()
  refreshAll()
})
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

.matrix-card {
  margin-bottom: 16px;
}

.summary-card :deep(.el-card__body),
.matrix-card :deep(.el-card__body) {
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

.summary-value-alert {
  color: var(--el-color-warning);
}

.matrix-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.matrix-cell {
  font-weight: 600;
}

.matrix-empty {
  color: var(--el-text-color-placeholder);
}

.matrix-no-agent {
  color: var(--mao-muted);
}

.group-tag {
  margin-left: 6px;
}

.handled-info {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.readonly-hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.mobile-status {
  margin-left: 6px;
}

.mobile-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
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

