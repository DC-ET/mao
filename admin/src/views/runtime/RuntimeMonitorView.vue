<template>
  <div class="runtime-monitor">
    <el-row :gutter="16" class="metric-row">
      <el-col v-for="item in runtimeShortcuts" :key="item.phase || 'all'" :xs="24" :sm="12" :md="6">
        <el-card
          shadow="hover"
          class="clickable-card"
          :class="{ 'is-active': filters.phase === item.phase }"
          @click="selectPhase(item.phase)"
        >
          <div class="metric" :class="{ danger: item.phase === 'FAILED' }">
            <span>{{ item.label }}</span>
            <strong v-if="filters.phase === item.phase">{{ total }}</strong>
            <strong v-else class="metric-hint">查看</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>运行中与异常会话</span>
          <el-button @click="fetchSessions">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input v-model="filters.keyword" clearable placeholder="标题/摘要" style="width: 180px" @keyup.enter="handleSearch" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="执行模式">
            <el-select v-model="filters.executionMode" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
              <el-option
                v-for="opt in EXECUTION_MODE_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="阶段">
            <el-select v-model="filters.phase" clearable placeholder="重点状态" style="width: 160px" @change="handleSearch">
              <el-option
                v-for="opt in RUNTIME_PHASE_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="sessions" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column prop="userName" label="用户" width="120" />
        <el-table-column prop="agentName" label="Agent" width="130" />
        <el-table-column prop="executionMode" label="模式" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.executionMode === 'LOCAL' ? 'warning' : 'primary'">
              {{ executionModeLabel(row.executionMode) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="阶段" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="phaseTag(row.phase)">{{ phaseLabel(row.phase) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="contextTokens" label="上下文 Token" width="130" align="right" />
        <el-table-column prop="lastActivityAt" label="最后活动" width="170" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="router.push(`/sessions/${row.id}`)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in sessions" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.title || '-' }}</span>
            <el-tag size="small" :type="phaseTag(row.phase)">{{ phaseLabel(row.phase) }}</el-tag>
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
            <el-tag size="small" :type="row.executionMode === 'LOCAL' ? 'warning' : 'primary'">
              {{ executionModeLabel(row.executionMode) }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">活动</span>
            <span>{{ row.lastActivityAt || '-' }}</span>
          </div>
          <div class="mobile-card-actions">
            <el-button type="primary" link @click="router.push(`/sessions/${row.id}`)">查看</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && sessions.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[20, 50, 100]"
        :total="total"
        @current-change="fetchSessions"
        @size-change="handleSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, onActivated } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import {
  EXECUTION_MODE_OPTIONS,
  RUNTIME_PHASE_OPTIONS,
  executionModeLabel,
  phaseLabel
} from '../../utils/labels'

const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const loading = ref(false)
const sessions = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  executionMode: '',
  phase: '',
  keyword: ''
})

const runtimeShortcuts = [
  { label: '全部重点', phase: '' },
  { label: '运行中', phase: 'RUNNING' },
  { label: '待审批', phase: 'WAITING_APPROVAL' },
  { label: '失败', phase: 'FAILED' }
]

function applyRouteQuery() {
  const q = route.query
  if (typeof q.executionMode === 'string') filters.executionMode = q.executionMode
  if (typeof q.phase === 'string') filters.phase = q.phase
  if (typeof q.keyword === 'string') filters.keyword = q.keyword
}

function selectPhase(phase: string) {
  filters.phase = phase
  handleSearch()
}

function phaseTag(phase: string) {
  if (phase === 'FAILED') return 'danger'
  if (phase === 'CANCELLED' || phase === 'WAITING_APPROVAL') return 'warning'
  if (phase === 'COMPLETED') return 'success'
  return 'primary'
}

let fetchSessionsSeq = 0
async function fetchSessions() {
  const seq = ++fetchSessionsSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.executionMode) params.executionMode = filters.executionMode
    if (filters.phase) params.phase = filters.phase
    if (filters.keyword) params.keyword = filters.keyword
    const { data } = await api.get('/admin/runtime/sessions', { params })
    if (seq !== fetchSessionsSeq) return
    sessions.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchSessionsSeq) loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchSessions()
}

function handleReset() {
  filters.executionMode = ''
  filters.phase = ''
  filters.keyword = ''
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchSessions()
}

// keep-alive 下首次挂载 onMounted 与 onActivated 同时触发，跳过首次避免重复请求
let activatedOnce = false
onMounted(() => {
  if (!activatedOnce) {
    activatedOnce = true
    applyRouteQuery()
    fetchSessions()
  }
})
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  fetchSessions()
})
</script>

<style scoped>
.metric-row {
  margin-bottom: 16px;
}

.clickable-card {
  cursor: pointer;
}

.clickable-card.is-active {
  border-color: var(--mao-accent);
}

.metric {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.metric span {
  color: var(--el-text-color-regular);
}

.metric strong {
  font-size: 24px;
  color: var(--mao-ink);
}

.metric.danger strong {
  color: #f56c6c;
}

.metric-hint {
  font-size: 14px !important;
  font-weight: 400 !important;
  color: var(--mao-muted) !important;
}

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

@media (max-width: 768px) {
  .runtime-monitor :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .runtime-monitor :deep(.el-col) {
    max-width: 50%;
    flex: 0 0 50%;
  }
}
</style>
