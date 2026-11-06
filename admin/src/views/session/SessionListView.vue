<template>
  <div class="session-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>会话管理</span>
          <el-tooltip content="扫描最近一段时间内因 402/403（额度不足等）失败的主会话，一键发起恢复" placement="top">
            <el-button v-if="canWrite" type="warning" plain size="small" @click="openRecoveryDialog">
              恢复 402/403 失败会话
            </el-button>
          </el-tooltip>
        </div>
      </template>

      <!-- Filter form -->
      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="filters.keyword"
                :placeholder="filters.messageScope === 'ALL' ? '标题/摘要/消息内容' : '标题/摘要/对话消息'"
                clearable
                style="width: 200px"
                @keyup.enter="handleSearch"
                @clear="handleSearch"
              />
            </el-form-item>
            <el-form-item label="搜索范围">
              <el-select v-model="filters.messageScope" style="width: 180px">
                <el-option
                  v-for="opt in SEARCH_SCOPE_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="活跃时间">
              <el-select v-model="filters.activityRange" style="width: 120px">
                <el-option
                  v-for="opt in ACTIVITY_RANGE_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-date-picker
                v-if="filters.activityRange === 'CUSTOM'"
                v-model="filters.activityCustomRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                style="width: 250px; margin-left: 8px"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="用户">
            <el-select v-model="filters.userId" placeholder="全部用户" clearable filterable style="width: 160px">
              <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username" :value="u.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Agent">
            <el-select v-model="filters.agentId" placeholder="全部 Agent" clearable filterable style="width: 160px">
              <el-option v-for="a in agentOptions" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="执行模式">
            <el-select v-model="filters.executionMode" placeholder="全部" clearable style="width: 120px">
              <el-option
                v-for="opt in EXECUTION_MODE_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="任务阶段">
            <el-select v-model="filters.phase" placeholder="全部" clearable style="width: 140px">
              <el-option v-for="p in PHASE_OPTIONS" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px">
              <el-option
                v-for="opt in SESSION_STATUS_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="来源">
            <el-select v-model="filters.source" placeholder="全部" clearable style="width: 130px">
              <el-option v-for="opt in SESSION_SOURCE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <!-- Table -->
      <el-table v-if="!isMobile" :data="sessions" stripe v-loading="loading">
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="标题" min-width="200">
          <template #default="{ row }">
            <div>{{ row.title || '-' }}</div>
            <div v-if="row.matchSnippet" class="match-snippet" :title="row.matchSnippet">命中消息：{{ row.matchSnippet }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="userName" label="用户" width="120" show-overflow-tooltip />
        <el-table-column prop="agentName" label="Agent" width="120" show-overflow-tooltip />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tooltip :content="sessionTypeTip(row)" placement="top">
              <el-tag :type="sessionTypeTag(row.sessionType).type" size="small">
                {{ sessionTypeTag(row.sessionType).label }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="executionMode" label="执行模式" width="100">
          <template #default="{ row }">
            <el-tag :type="row.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ executionModeLabel(row.executionMode) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="100">
          <template #default="{ row }">
            <el-tag :type="sessionSourceTagType(row.source)" size="small">
              {{ sessionSourceLabel(row.source) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="任务阶段" width="120">
          <template #default="{ row }">
            <el-tooltip v-if="row.failureReason" :content="row.failureReason" placement="top">
              <el-tag :type="phaseTagType(row.phase, row.pendingQuestionCount)" size="small">{{ phaseLabel(row.phase, row.pendingQuestionCount) }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="phaseTagType(row.phase, row.pendingQuestionCount)" size="small">{{ phaseLabel(row.phase, row.pendingQuestionCount) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="contextTokens" label="上下文Token" width="110" align="right" />
        <el-table-column label="Token 水位" width="110">
          <template #default="{ row }">
            <el-progress
              :percentage="tokenPercent(row)"
              :stroke-width="8"
              :show-text="false"
              :status="tokenPercent(row) > 80 ? 'exception' : undefined"
            />
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="lastActivityAt" label="最后活动" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看</el-button>
            <el-button v-if="canWrite" link size="small" @click="handleArchive(row)">归档</el-button>
            <el-tooltip v-if="canWrite && !canDelete(row)" content="会话运行中，无法删除；请先等待其结束或取消" placement="top">
              <span class="disabled-btn-wrap">
                <el-button type="danger" link size="small" disabled>删除</el-button>
              </span>
            </el-tooltip>
            <el-button v-else-if="canWrite" type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile card list -->
      <div v-else class="mobile-card-list">
        <el-card v-for="row in sessions" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.title || '-' }}</span>
            <el-tag :type="phaseTagType(row.phase, row.pendingQuestionCount)" size="small">{{ phaseLabel(row.phase, row.pendingQuestionCount) }}</el-tag>
          </div>
          <div v-if="row.failureReason" class="mobile-card-row">
            <span class="mobile-card-label">失败原因</span>
            <span class="mobile-failure-reason">{{ row.failureReason }}</span>
          </div>
          <div v-if="row.matchSnippet" class="mobile-card-row match-snippet">
            <span class="mobile-card-label">消息</span>
            <span>{{ row.matchSnippet }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ row.userName || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Agent</span>
            <span>{{ row.agentName || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">模式</span>
            <el-tag :type="row.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ executionModeLabel(row.executionMode) }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">来源</span>
            <el-tag :type="sessionSourceTagType(row.source)" size="small">
              {{ sessionSourceLabel(row.source) }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">类型</span>
            <el-tag :type="sessionTypeTag(row.sessionType).type" size="small">
              {{ sessionTypeTag(row.sessionType).label }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Token</span>
            <el-progress
              :percentage="tokenPercent(row)"
              :stroke-width="8"
              :show-text="false"
              :status="tokenPercent(row) > 80 ? 'exception' : undefined"
              style="flex: 1"
            />
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">活动</span>
            <span>{{ formatDateTime(row.lastActivityAt) }}</span>
          </div>
          <div class="mobile-card-actions">
            <el-button type="primary" link @click="handleView(row)">查看</el-button>
            <el-button v-if="canWrite" link @click="handleArchive(row)">归档</el-button>
            <el-tooltip v-if="canWrite && !canDelete(row)" content="会话运行中，无法删除；请先等待其结束或取消" placement="top">
              <span class="disabled-btn-wrap">
                <el-button type="danger" link disabled>删除</el-button>
              </span>
            </el-tooltip>
            <el-button v-else-if="canWrite" type="danger" link @click="handleDelete(row)">删除</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && sessions.length === 0" description="暂无数据" />
      </div>

      <!-- Pagination -->
      <ResponsivePagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        style="margin-top: 16px; justify-content: flex-end"
        @current-change="fetchSessions"
        @size-change="handleSizeChange"
      />
    </el-card>

    <!-- 恢复 402/403 失败会话（技术方案 2026-11-06）：预览清单 + 勾选 + 一键发起 -->
    <el-dialog
      v-model="recoveryVisible"
      title="恢复 402/403 失败会话"
      width="960px"
      :close-on-click-modal="false"
    >
      <div class="recovery-desc">
        扫描最近一段时间内活跃、当前失败、且最后一次模型调用因 402/403 中断的主会话，一键在后台续跑（不插入新消息）。
        恢复后原飞书/钉钉进度卡片会原地复活并持续更新；无卡片的会话在完成后推送最终回复。发起前请先确认模型额度已恢复。
      </div>
      <div class="recovery-filters">
        <el-select v-model="recovery.windowHours" style="width: 150px" @change="fetchRecoveryPreview">
          <el-option label="最近 24 小时" :value="24" />
          <el-option label="最近 3 天" :value="72" />
          <el-option label="最近 7 天" :value="168" />
        </el-select>
        <el-select v-model="recovery.scope" style="width: 170px" @change="fetchRecoveryPreview">
          <el-option label="仅额度类错误" value="QUOTA" />
          <el-option label="全部 402/403" value="ALL_402_403" />
        </el-select>
        <el-button type="primary" plain :loading="recoveryLoading" @click="fetchRecoveryPreview">重新扫描</el-button>
      </div>
      <el-alert
        v-if="recoverableCount > RECOVERY_MAX_BATCH"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        :title="`可恢复 ${recoverableCount} 个，单批最多 ${RECOVERY_MAX_BATCH} 个，默认已勾选最近活跃的 ${RECOVERY_MAX_BATCH} 个，请分批恢复其余会话`"
      />
      <el-table
        ref="recoveryTableRef"
        :data="recoveryItems"
        v-loading="recoveryLoading"
        max-height="420"
        @selection-change="onRecoverySelectionChange"
      >
        <template #empty>
          <el-empty description="没有符合条件的失败会话" :image-size="60" />
        </template>
        <el-table-column type="selection" width="42" :selectable="(row: RecoveryItem) => row.willRecover" />
        <el-table-column prop="sessionId" label="ID" width="70" />
        <el-table-column label="会话标题" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.title || `#${row.sessionId}` }}</span>
            <el-tooltip
              v-if="row.scheduledTask"
              :content="`该会话由定时任务「${row.scheduledTask.name}」触发，恢复不会修正任务运行记录`"
              placement="top"
            >
              <el-tag size="small" type="warning" style="margin-left: 4px">定时任务</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="userName" label="用户" width="110" show-overflow-tooltip />
        <el-table-column prop="failedAt" label="失败时间" width="165" :formatter="formatDateTimeColumn" />
        <el-table-column prop="errorSummary" label="错误摘要" min-width="230" show-overflow-tooltip />
        <el-table-column prop="lastUserMessage" label="最后用户消息" min-width="170" show-overflow-tooltip />
        <el-table-column label="卡片续更" width="88">
          <template #default="{ row }">
            <el-tag :type="row.hasProgressCard ? 'success' : 'info'" size="small">
              {{ row.hasProgressCard ? '有' : '无' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="跳过原因" width="130">
          <template #default="{ row }">
            <span v-if="row.skipReason">{{ recoverySkipLabel(row.skipReason) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="recoveryVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="recoverySubmitting"
          :disabled="recoverySelected.length === 0"
          @click="submitRecovery"
        >
          确认恢复 {{ recoverySelected.length }} 个
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted, onActivated, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { SESSION_SOURCE_OPTIONS, sessionSourceLabel, sessionSourceTagType } from '../../utils/sessionSourceLabels'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import {
  ACTIVITY_RANGE_DEFAULT,
  ACTIVITY_RANGE_OPTIONS,
  activityRangeParams,
  defaultCustomRange,
  isActivityRangeValue
} from '../../utils/sessionActivityRange'
import {
  EXECUTION_MODE_OPTIONS,
  PHASE_OPTIONS,
  SEARCH_SCOPE_OPTIONS,
  SESSION_STATUS_OPTIONS,
  executionModeLabel,
  phaseLabel,
  sessionTypeTag
} from '../../utils/labels'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('session:write'))
const { isMobile } = useBreakpoint()
const loading = ref(false)
const sessions = ref<any[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const filters = reactive({
  userId: null as number | null,
  agentId: null as number | null,
  executionMode: '' as string,
  phase: '' as string,
  status: '' as string,
  source: '' as string,
  keyword: '' as string,
  messageScope: 'CONVERSATION' as string,
  // 「活跃时间」筛选：默认最近 7 天（后端同口径兜底），ALL = 全部时间
  activityRange: ACTIVITY_RANGE_DEFAULT as string,
  activityCustomRange: null as [string, string] | null
})

// 切到「自定义」时给一个最近 7 天的初始区间，避免空区间悄悄落回默认档
watch(() => filters.activityRange, (next) => {
  if (next === 'CUSTOM' && !filters.activityCustomRange) {
    filters.activityCustomRange = defaultCustomRange()
  }
})

const userOptions = ref<Array<{ id: number; username: string; displayName: string }>>([])
const agentOptions = ref<Array<{ id: number; name: string }>>([])

function applyRouteQuery() {
  const q = route.query
  filters.userId = typeof q.userId === 'string' && q.userId ? Number(q.userId) : null
  filters.agentId = typeof q.agentId === 'string' && q.agentId ? Number(q.agentId) : null
  filters.executionMode = typeof q.executionMode === 'string' ? q.executionMode : ''
  filters.phase = typeof q.phase === 'string' ? q.phase : ''
  filters.status = typeof q.status === 'string' ? q.status : ''
  filters.source = typeof q.source === 'string' ? q.source : ''
  filters.keyword = typeof q.keyword === 'string' ? q.keyword : ''
  // 非法值回落到默认口径，避免地址栏拼错就查不到东西
  filters.messageScope = q.messageScope === 'ALL' ? 'ALL' : 'CONVERSATION'
  // 活跃时间：range=7D/30D/90D/ALL；自定义档读 dateFrom/dateTo，缺失时回落默认档
  const range = typeof q.range === 'string' ? q.range.toUpperCase() : ''
  filters.activityRange = isActivityRangeValue(range) ? range : ACTIVITY_RANGE_DEFAULT
  const dateFrom = typeof q.dateFrom === 'string' ? q.dateFrom : ''
  const dateTo = typeof q.dateTo === 'string' ? q.dateTo : ''
  filters.activityCustomRange = dateFrom && dateTo ? [dateFrom, dateTo] : null
  if (filters.activityRange === 'CUSTOM' && !filters.activityCustomRange) {
    filters.activityRange = ACTIVITY_RANGE_DEFAULT
  }
}

/** 上次已经写进筛选表单的 query。地址没变时只刷新列表，不冲掉表单里尚未写入 URL 的条件。 */
let appliedQuery = ''

function syncRouteAndFetch() {
  if (route.name !== 'Sessions') return
  const next = JSON.stringify(route.query)
  if (next !== appliedQuery) {
    appliedQuery = next
    applyRouteQuery()
    currentPage.value = 1
  }
  fetchSessions()
}

function phaseTagType(phase: string, pendingQuestionCount?: number): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'RUNNING' && (pendingQuestionCount ?? 0) > 0) return 'warning'
  switch (phase) {
    case 'RUNNING': return 'primary'
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

/** 悬停说明来源：有父会话 ID 时指回父会话，否则解释这类会话怎么来的。 */
function sessionTypeTip(row: { sessionType?: string | null; parentSessionId?: number | null }): string {
  if (row.parentSessionId != null) return `父会话 #${row.parentSessionId}`
  if (row.sessionType === 'SIDE_TASK') return '由主会话拉起的边路任务'
  if (row.sessionType === 'SUBAGENT') return '由主会话委派的子代理'
  return '用户直接发起的主会话'
}

let fetchSessionsSeq = 0
async function fetchSessions() {
  const seq = ++fetchSessionsSeq
  loading.value = true
  try {
    const params: Record<string, any> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.userId) params.userId = filters.userId
    if (filters.agentId) params.agentId = filters.agentId
    if (filters.executionMode) params.executionMode = filters.executionMode
    if (filters.phase) params.phase = filters.phase
    if (filters.status) params.status = filters.status
    if (filters.source) params.source = filters.source
    if (filters.keyword) params.keyword = filters.keyword
    // 默认口径由后端决定，只在放宽到全部消息时传参
    if (filters.messageScope === 'ALL') params.messageScope = 'ALL'
    // 活跃时间窗：预设档位交给后端按上海日历计算，自定义下发具体日期
    Object.assign(params, activityRangeParams(filters.activityRange, filters.activityCustomRange))

    const { data } = await api.get('/admin/sessions', { params })
    if (seq !== fetchSessionsSeq) return
    sessions.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchSessionsSeq) loading.value = false
  }
}

async function fetchOptions() {
  // allSettled：任一接口失败只置空对应下拉（拦截器已提示），
  // 不再连带两个下拉同时为空，也不会抛 unhandled rejection
  const [usersRes, agentsRes] = await Promise.allSettled([
    api.get('/admin/sessions/options/users'),
    api.get('/admin/sessions/options/agents')
  ])
  userOptions.value = usersRes.status === 'fulfilled' ? usersRes.value.data || [] : []
  agentOptions.value = agentsRes.status === 'fulfilled' ? agentsRes.value.data || [] : []
}

function handleSearch() {
  currentPage.value = 1
  fetchSessions()
}

function handleReset() {
  filters.userId = null
  filters.agentId = null
  filters.executionMode = ''
  filters.phase = ''
  filters.status = ''
  filters.source = ''
  filters.keyword = ''
  filters.messageScope = 'CONVERSATION'
  filters.activityRange = ACTIVITY_RANGE_DEFAULT
  filters.activityCustomRange = null
  currentPage.value = 1
  fetchSessions()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchSessions()
}

function handleView(row: any) {
  router.push(`/sessions/${row.id}`)
}

/** 运行中的会话不允许删除（后端拒绝），提前禁用并说明。 */
const RUNNING_DELETE_PHASES = new Set(['RUNNING', 'WAITING_APPROVAL', 'RESUMING', 'CANCELLING'])

function canDelete(row: any): boolean {
  return !RUNNING_DELETE_PHASES.has(row?.phase)
}

async function handleArchive(row: any) {
  try {
    await ElMessageBox.confirm(`确认归档会话「${row.title || `#${row.id}`}」？归档后可在会话列表按状态筛选查看。`, '归档会话', {
      confirmButtonText: '归档',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  try {
    await api.put(`/admin/sessions/${row.id}/archive`)
    ElMessage.success('已归档')
    fetchSessions()
  } catch { /* 拦截器已提示失败 */ }
}

async function handleDelete(row: any) {
  if (!canDelete(row)) {
    ElMessage.warning('会话运行中，无法删除；请先等待其结束或取消')
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除会话「${row.title || `#${row.id}`}」？将级联清理消息、上下文与运行文件，不可恢复。`, '删除会话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'error'
    })
  } catch {
    return
  }
  try {
    await api.delete(`/admin/sessions/${row.id}`)
    ElMessage.success('已删除')
    const maxPage = Math.max(1, Math.ceil((total.value - 1) / pageSize.value))
    if (currentPage.value > maxPage) currentPage.value = maxPage
    fetchSessions()
  } catch { /* 拦截器已提示失败 */ }
}

// ---- 恢复 402/403 失败会话（技术方案 2026-11-06）----

interface RecoveryItem {
  sessionId: number
  userName: string | null
  title: string | null
  failedAt: string | null
  errorSummary: string
  lastUserMessage: string
  scheduledTask: { id: number; name: string } | null
  hasProgressCard: boolean
  willRecover: boolean
  skipReason: string | null
}

/** 跳过原因中文案（与后端 FailedRecoverySkipReason 枚举对齐） */
const RECOVERY_SKIP_LABELS: Record<string, string> = {
  NOT_FAILED: '非失败状态',
  LOCAL_MODE: '本地执行模式',
  NON_NORMAL_SESSION: '非主会话',
  NOT_402_403: '非 402/403 错误',
  NON_QUOTA_ERROR: '非额度类错误',
  PENDING_TASK_RETRY: '定时任务待重试',
  ALREADY_RUNNING: '执行中',
  RECOVERING: '恢复中',
  EXECUTOR_BUSY: '执行池繁忙',
  SUBMIT_FAILED: '提交失败'
}

function recoverySkipLabel(reason: string): string {
  return RECOVERY_SKIP_LABELS[reason] ?? reason
}

const recoveryVisible = ref(false)
const recovery = reactive({ windowHours: 24, scope: 'QUOTA' })
const recoveryItems = ref<RecoveryItem[]>([])
const recoverySelected = ref<RecoveryItem[]>([])
const recoveryLoading = ref(false)
const recoverySubmitting = ref(false)
const recoveryTableRef = ref()

/** 单批恢复上限（与后端 FAILED_RECOVERY_MAX_BATCH 对齐） */
const RECOVERY_MAX_BATCH = 20
const recoverableCount = computed(() => recoveryItems.value.filter((item) => item.willRecover).length)

function openRecoveryDialog() {
  recoveryVisible.value = true
  recoverySelected.value = []
  fetchRecoveryPreview()
}

let fetchRecoverySeq = 0
async function fetchRecoveryPreview() {
  const seq = ++fetchRecoverySeq
  recoveryLoading.value = true
  try {
    const { data } = await api.get('/admin/sessions/recover-failed/preview', {
      params: { windowHours: recovery.windowHours, scope: recovery.scope }
    })
    if (seq !== fetchRecoverySeq) return
    recoveryItems.value = data?.items || []
    recoverySelected.value = []
    // 默认勾选可恢复项（技术方案 §4.6），单批最多 RECOVERY_MAX_BATCH 个（列表按最后活跃倒序，
    // 即默认勾选最近活跃的一批）；不可恢复行 selectable 已禁用不会进勾选
    await nextTick()
    recoveryItems.value
      .filter((item) => item.willRecover)
      .slice(0, RECOVERY_MAX_BATCH)
      .forEach((item) => recoveryTableRef.value?.toggleRowSelection(item, true))
  } catch { /* 拦截器已提示失败 */ } finally {
    if (seq === fetchRecoverySeq) recoveryLoading.value = false
  }
}

function onRecoverySelectionChange(rows: RecoveryItem[]) {
  recoverySelected.value = rows
}

async function submitRecovery() {
  const ids = recoverySelected.value.map((item) => item.sessionId)
  if (ids.length === 0) return
  if (ids.length > RECOVERY_MAX_BATCH) {
    ElMessage.warning(`单批最多恢复 ${RECOVERY_MAX_BATCH} 个会话，请分批恢复`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认对选中的 ${ids.length} 个会话发起恢复？恢复在后台异步执行，原渠道卡片会持续更新；请先确认模型额度已恢复。`,
      '确认恢复',
      { confirmButtonText: '发起恢复', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  recoverySubmitting.value = true
  try {
    const { data } = await api.post('/admin/sessions/recover-failed/run', {
      sessionIds: ids,
      scope: recovery.scope
    })
    const accepted = data?.accepted?.length ?? 0
    const skipped = data?.skipped?.length ?? 0
    ElMessage.success(`已发起 ${accepted} 个恢复，跳过 ${skipped} 个，恢复进度将更新到原会话卡片`)
    recoveryVisible.value = false
    fetchSessions()
  } catch { /* 拦截器已提示失败 */ } finally {
    recoverySubmitting.value = false
  }
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000

function tokenPercent(row: { contextTokens?: number; contextWindowTokens?: number }) {
  const tokens = row.contextTokens
  if (!tokens) return 0
  const windowTokens = row.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS
  return Math.min(100, Math.round((tokens / windowTokens) * 100))
}

onMounted(() => {
  appliedQuery = JSON.stringify(route.query)
  applyRouteQuery()
  fetchSessions()
  fetchOptions()
})

// 组件被 keep-alive 缓存时，query 变化不会重建页面。
// 只在会话列表自己的地址上同步，避免切到详情时把筛选清掉。
watch(() => route.fullPath, () => {
  syncRouteAndFetch()
})

// When returning from the session detail page (kept alive), refresh the list
// so any changes made there are reflected, while preserving current filters/page.
// 首次挂载时 onMounted 与 onActivated 都会触发，跳过首次避免重复请求。
let activatedOnce = false
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  syncRouteAndFetch()
})
</script>

<style scoped>
.session-list {
  width: 100%;
}

.card-header {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.recovery-desc {
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.recovery-filters {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.search-form {
  margin-bottom: 16px;
}

.search-form .el-form-item {
  margin-bottom: 12px;
}

.disabled-btn-wrap {
  display: inline-flex;
  margin: 0;
}

.match-snippet {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 移动端失败原因限 3 行：完整异常串/堆栈进会话详情看 */
.mobile-failure-reason {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  min-width: 0;
  word-break: break-word;
}

@media (max-width: 768px) {
  .search-form {
    margin-bottom: 8px;
  }
}
</style>
