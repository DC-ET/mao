<template>
  <div class="session-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>会话管理</span>
        </div>
      </template>

      <!-- Filter form -->
      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input v-model="filters.keyword" placeholder="标题/摘要/消息内容" clearable style="width: 200px" @keyup.enter="handleSearch" @clear="handleSearch" />
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
        <el-table-column prop="executionMode" label="执行模式" width="100">
          <template #default="{ row }">
            <el-tag :type="row.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ executionModeLabel(row.executionMode) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="任务阶段" width="120">
          <template #default="{ row }">
            <el-tag :type="phaseTagType(row.phase, row.pendingQuestionCount)" size="small">{{ phaseLabel(row.phase, row.pendingQuestionCount) }}</el-tag>
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
            <el-button v-if="canWrite" type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
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
            <el-button v-if="canWrite" type="danger" link @click="handleDelete(row)">删除</el-button>
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted, onActivated, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import {
  EXECUTION_MODE_OPTIONS,
  PHASE_OPTIONS,
  SESSION_STATUS_OPTIONS,
  executionModeLabel,
  phaseLabel
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
  keyword: '' as string
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
  filters.keyword = typeof q.keyword === 'string' ? q.keyword : ''
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
    if (filters.keyword) params.keyword = filters.keyword

    const { data } = await api.get('/admin/sessions', { params })
    if (seq !== fetchSessionsSeq) return
    sessions.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchSessionsSeq) loading.value = false
  }
}

async function fetchOptions() {
  const [usersRes, agentsRes] = await Promise.all([
    api.get('/admin/sessions/options/users'),
    api.get('/admin/sessions/options/agents')
  ])
  userOptions.value = usersRes.data || []
  agentOptions.value = agentsRes.data || []
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
  filters.keyword = ''
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
    fetchSessions()
  } catch { /* 拦截器已提示失败 */ }
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
}

.search-form {
  margin-bottom: 16px;
}

.search-form .el-form-item {
  margin-bottom: 12px;
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

@media (max-width: 768px) {
  .search-form {
    margin-bottom: 8px;
  }
}
</style>
