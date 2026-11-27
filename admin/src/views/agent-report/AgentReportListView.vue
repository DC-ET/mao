<template>
  <div class="agent-report-view">
    <!-- 状态统计条：各处置状态数量（点击联动列表筛选） -->
    <el-card class="summary-card">
      <div class="summary-strip">
        <div
          v-for="opt in AGENT_REPORT_STATUS_OPTIONS"
          :key="opt.value"
          class="summary-item summary-item-clickable"
          @click="applyStatusFilter(opt.value)"
        >
          <div class="summary-label">{{ opt.label }}</div>
          <div class="summary-value" :class="{ 'summary-value-alert': opt.value === 'OPEN' && summary.openCount > 0 }">
            {{ summary.byStatus[opt.value] ?? 0 }}
          </div>
        </div>
      </div>
    </el-card>

    <!-- 上报列表 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent 上报</span>
          <el-button @click="refreshAll">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
            <el-option v-for="opt in AGENT_REPORT_STATUS_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="filters.category" clearable placeholder="全部" style="width: 150px" @change="handleSearch">
            <el-option v-for="opt in AGENT_REPORT_CATEGORY_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="级别">
          <el-select v-model="filters.severity" clearable placeholder="全部" style="width: 110px" @change="handleSearch">
            <el-option v-for="opt in AGENT_REPORT_SEVERITY_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
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

      <el-table v-if="!isMobile" :data="items" v-loading="loading" stripe row-key="id">
        <el-table-column label="时间" width="165">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="类别" width="110">
          <template #default="{ row }">{{ agentReportCategoryLabel(row.category) }}</template>
        </el-table-column>
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <el-tag :type="agentReportSeverityTagType(row.severity)" size="small">
              {{ agentReportSeverityLabel(row.severity) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <el-button link type="primary" class="title-link" @click="openDetail(row)">{{ row.title }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ agentLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="用户" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ userLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="agentReportStatusTagType(row.status)" size="small">{{ agentReportStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="canWrite && row.status === 'OPEN'" link type="primary" @click="handleAcknowledge(row)">
              确认
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无上报" :image-size="48" />
        </template>
      </el-table>

      <!-- 移动端卡片列表 -->
      <div v-else class="report-cards" v-loading="loading">
        <el-card v-for="row in items" :key="row.id" class="report-card" shadow="never" @click="openDetail(row)">
          <div class="report-card-head">
            <el-tag :type="agentReportSeverityTagType(row.severity)" size="small">
              {{ agentReportSeverityLabel(row.severity) }}
            </el-tag>
            <span class="report-card-category">{{ agentReportCategoryLabel(row.category) }}</span>
            <el-tag :type="agentReportStatusTagType(row.status)" size="small">{{ agentReportStatusLabel(row.status) }}</el-tag>
          </div>
          <div class="report-card-title">{{ row.title }}</div>
          <div class="report-card-time">{{ formatDateTime(row.createdAt) }} · {{ agentLabel(row) }}</div>
        </el-card>
        <el-empty v-if="!loading && items.length === 0" description="暂无上报" :image-size="48" />
      </div>

      <ResponsivePagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        @current-change="fetchList"
        @size-change="handleSizeChange"
      />
    </el-card>

    <!-- 详情抽屉：detail 纯文本渲染（防注入内容执行），可跳转会话审计核对上下文 -->
    <el-drawer
      v-model="detailVisible"
      title="上报详情"
      :size="isMobile ? '100%' : '720px'"
      destroy-on-close
    >
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="detail">
          <el-descriptions :column="isMobile ? 1 : 2" size="small" border>
            <el-descriptions-item label="ID">{{ detail.id }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="agentReportStatusTagType(detail.status)" size="small">
                {{ agentReportStatusLabel(detail.status) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="类别">{{ agentReportCategoryLabel(detail.category) }}</el-descriptions-item>
            <el-descriptions-item label="级别">
              <el-tag :type="agentReportSeverityTagType(detail.severity)" size="small">
                {{ agentReportSeverityLabel(detail.severity) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="Agent">{{ agentLabel(detail) }}</el-descriptions-item>
            <el-descriptions-item label="用户">{{ userLabel(detail) }}</el-descriptions-item>
            <el-descriptions-item label="来源会话">
              <el-button v-if="detail.sessionId" link type="primary" @click="goSession(detail.sessionId)">
                #{{ detail.sessionId }}
              </el-button>
              <span v-else>-</span>
            </el-descriptions-item>
            <el-descriptions-item label="上报时间">{{ formatDateTime(detail.createdAt) }}</el-descriptions-item>
            <el-descriptions-item v-if="detail.resolvedByName" label="处置人">{{ detail.resolvedByName }}</el-descriptions-item>
            <el-descriptions-item v-if="detail.resolvedAt" label="处置时间">{{ formatDateTime(detail.resolvedAt) }}</el-descriptions-item>
            <el-descriptions-item label="标题" :span="isMobile ? 1 : 2">{{ detail.title }}</el-descriptions-item>
            <el-descriptions-item v-if="detail.resolutionNote" label="处置备注" :span="isMobile ? 1 : 2">
              {{ detail.resolutionNote }}
            </el-descriptions-item>
          </el-descriptions>
          <div class="detail-section-title">详细内容</div>
          <!-- 上报内容来自模型、可能被 prompt injection 操纵：一律纯文本渲染，不渲染富文本 / Markdown -->
          <pre class="detail-block">{{ detail.detail || '（无）' }}</pre>
          <div v-if="canWrite && availableActions.length > 0" class="detail-actions">
            <el-button v-if="availableActions.includes('ACKNOWLEDGED')" type="primary" @click="handleAcknowledge(detail)">
              确认
            </el-button>
            <el-button v-if="availableActions.includes('RESOLVED')" type="success" @click="openResolveDialog('RESOLVED')">
              解决
            </el-button>
            <el-button v-if="availableActions.includes('DISMISSED')" type="info" @click="openResolveDialog('DISMISSED')">
              忽略
            </el-button>
          </div>
        </template>
        <el-empty v-else-if="!detailLoading" description="加载失败" :image-size="48" />
      </div>
    </el-drawer>

    <!-- 解决 / 忽略备注对话框（admin 暂无 ElMessageBox.prompt 先例，用小表单对话框） -->
    <el-dialog
      v-model="noteDialogVisible"
      :title="noteTarget === 'RESOLVED' ? '标记为已解决' : '忽略该上报'"
      width="420px"
      append-to-body
    >
      <el-input
        v-model="noteText"
        type="textarea"
        :rows="3"
        maxlength="2000"
        show-word-limit
        placeholder="处置备注（可选）"
      />
      <template #footer>
        <el-button @click="noteDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionSubmitting" @click="submitStatusAction">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import type { AgentReportCategory, AgentReportSeverity, AgentReportStatus } from '@mao/contracts'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import {
  AGENT_REPORT_CATEGORY_OPTIONS,
  AGENT_REPORT_SEVERITY_OPTIONS,
  AGENT_REPORT_STATUS_OPTIONS,
  agentReportCategoryLabel,
  agentReportSeverityLabel,
  agentReportSeverityTagType,
  agentReportStatusLabel,
  agentReportStatusTagType,
} from '../../utils/agentReportLabels'

interface AgentReportItem {
  id: number
  sessionId: number | null
  userId: number | null
  username: string | null
  agentId: number | null
  agentName: string | null
  category: AgentReportCategory
  severity: AgentReportSeverity
  title: string
  detail: string | null
  status: AgentReportStatus
  resolutionNote: string | null
  resolvedBy: number | null
  resolvedByName: string | null
  resolvedAt: string | null
  createdAt: string
}

const router = useRouter()
const { isMobile } = useBreakpoint()
const authStore = useAuthStore()

/** 写操作（确认/解决/忽略）门槛与后端 agent-report:write 一致：只读账号看不到入口。 */
const canWrite = computed(() => authStore.hasPermission('agent-report:write'))

function agentLabel(row: { agentId: number | null; agentName: string | null }) {
  return row.agentName || (row.agentId != null ? `#${row.agentId}` : '-')
}

function userLabel(row: { userId: number | null; username: string | null }) {
  return row.username || (row.userId != null ? `#${row.userId}` : '-')
}

function goSession(sessionId: number) {
  router.push(`/sessions/${sessionId}`)
}

const summary = ref<{ byStatus: Record<AgentReportStatus, number>; openCount: number }>({
  byStatus: { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED: 0, DISMISSED: 0 },
  openCount: 0,
})
const items = ref<AgentReportItem[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filters = reactive<{ status?: AgentReportStatus; category?: AgentReportCategory; severity?: AgentReportSeverity }>({})
const dateRange = ref<[string, string] | null>(null)

function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { page: page.value, pageSize: pageSize.value }
  if (filters.status) params.status = filters.status
  if (filters.category) params.category = filters.category
  if (filters.severity) params.severity = filters.severity
  if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
  if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
  return params
}

async function fetchSummary() {
  try {
    const { data } = await api.get('/agent-report/admin/summary')
    if (data?.byStatus) summary.value = data
  } catch {
    // 统计条失败不影响列表（接口抖动不连带白屏）
  }
}

async function fetchList() {
  loading.value = true
  try {
    const { data } = await api.get('/agent-report/admin/list', { params: buildParams() })
    items.value = data?.items ?? []
    total.value = data?.total ?? 0
  } catch {
    // 拦截器已提示失败；fetchList 被模板分页事件直接调用，必须吞掉 rejection
  } finally {
    loading.value = false
  }
}

async function refreshAll() {
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
  filters.status = undefined
  filters.category = undefined
  filters.severity = undefined
  dateRange.value = null
  handleSearch()
}

function applyStatusFilter(status: AgentReportStatus) {
  filters.status = status
  handleSearch()
}

// ---- 详情抽屉与状态处置 ----

const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<AgentReportItem | null>(null)

/** 状态机出边（与后端 STATUS_TRANSITIONS 同口径）：OPEN 可确认/解决/忽略；ACKNOWLEDGED 可解决/忽略；终态无操作。 */
const availableActions = computed<AgentReportStatus[]>(() => {
  if (detail.value == null) return []
  if (detail.value.status === 'OPEN') return ['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']
  if (detail.value.status === 'ACKNOWLEDGED') return ['RESOLVED', 'DISMISSED']
  return []
})

async function openDetail(row: AgentReportItem) {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const { data } = await api.get(`/agent-report/admin/${row.id}`)
    detail.value = data ?? null
  } catch {
    // 拦截器已提示失败
  } finally {
    detailLoading.value = false
  }
}

async function handleAcknowledge(row: AgentReportItem) {
  actionSubmitting.value = true
  try {
    const { data } = await api.put(`/agent-report/admin/${row.id}/status`, { status: 'ACKNOWLEDGED' })
    if (detail.value?.id === row.id) detail.value = data ?? detail.value
    ElMessage.success('已确认')
    refreshAll()
  } catch {
    // 拦截器已提示失败
  } finally {
    actionSubmitting.value = false
  }
}

const noteDialogVisible = ref(false)
const noteTarget = ref<'RESOLVED' | 'DISMISSED'>('RESOLVED')
const noteText = ref('')
const actionSubmitting = ref(false)

function openResolveDialog(target: 'RESOLVED' | 'DISMISSED') {
  noteTarget.value = target
  noteText.value = ''
  noteDialogVisible.value = true
}

async function submitStatusAction() {
  if (detail.value == null) return
  actionSubmitting.value = true
  try {
    const { data } = await api.put(`/agent-report/admin/${detail.value.id}/status`, {
      status: noteTarget.value,
      note: noteText.value.trim() || undefined,
    })
    detail.value = data ?? detail.value
    noteDialogVisible.value = false
    ElMessage.success(noteTarget.value === 'RESOLVED' ? '已标记解决' : '已忽略')
    refreshAll()
  } catch {
    // 拦截器已提示失败
  } finally {
    actionSubmitting.value = false
  }
}

onMounted(refreshAll)
onActivated(refreshAll)
</script>

<style scoped>
.agent-report-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.summary-strip {
  display: flex;
  gap: 48px;
  flex-wrap: wrap;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.summary-item-clickable {
  cursor: pointer;
}

.summary-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.summary-value {
  font-size: 24px;
  font-weight: 600;
}

.summary-value-alert {
  color: var(--el-color-warning);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.search-form {
  margin-bottom: 8px;
}

.title-link {
  padding: 0;
  font-weight: 400;
}

.report-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-card {
  cursor: pointer;
}

.report-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.report-card-category {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: 1;
}

.report-card-title {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  word-break: break-all;
}

.report-card-time {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.detail-section-title {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.detail-block {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  max-height: 40vh;
  overflow: auto;
}

.detail-actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
}
</style>
