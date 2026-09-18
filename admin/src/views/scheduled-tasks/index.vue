<template>
  <div class="scheduled-tasks">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>定时任务管理</span>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="filters.keyword"
                placeholder="任务名称/内容"
                clearable
                style="width: 180px"
                @keyup.enter="handleSearch"
                @clear="handleSearch"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="用户">
            <el-select v-model="filters.userId" placeholder="全部用户" clearable filterable style="width: 160px">
              <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username || `用户 #${u.id}`" :value="u.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Agent">
            <el-select v-model="filters.agentId" placeholder="全部 Agent" clearable filterable style="width: 160px">
              <el-option v-for="a in agentOptions" :key="a.id" :label="a.name || `Agent #${a.id}`" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px">
              <el-option label="启用" value="ACTIVE" />
              <el-option label="暂停" value="PAUSED" />
            </el-select>
          </el-form-item>
          <el-form-item label="完结">
            <el-select v-model="filters.finished" placeholder="全部" clearable style="width: 120px">
              <el-option label="进行中" :value="false" />
              <el-option label="已完结" :value="true" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="tasks" stripe v-loading="loading">
        <template #empty>
          <el-empty description="暂无定时任务" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="任务名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="用户" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ userName(row.userId) }}</template>
        </el-table-column>
        <el-table-column label="Agent" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ agentName(row.agentId) }}</template>
        </el-table-column>
        <el-table-column prop="cronExpression" label="Cron 表达式" width="150">
          <template #default="{ row }">
            <span>{{ row.cronExpression }}</span>
            <el-tag v-if="row.once" type="warning" size="small" style="margin-left: 4px">一次</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ row.status === 'ACTIVE' ? '启用' : '暂停' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="finished" label="完结" width="90">
          <template #default="{ row }">
            <el-tag
              v-if="row.finished"
              type="info"
              size="small"
              :title="row.finishedAt ? `完结于 ${formatDateTime(row.finishedAt)}` : '已完结'"
            >
              已完结
            </el-tag>
            <span v-else class="text-muted">进行中</span>
          </template>
        </el-table-column>
        <el-table-column prop="lastExecutionStatus" label="上次执行" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.lastExecutionStatus" :type="statusTagType(row.lastExecutionStatus)" size="small">
              {{ statusLabel(row.lastExecutionStatus) }}
            </el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="fireCount" label="触发次数" width="90" align="right" />
        <el-table-column prop="lastFireTime" label="上次触发" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="nextFireTime" label="下次触发" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="createdAt" label="创建时间" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-switch
              v-model="row.status"
              active-value="ACTIVE"
              inactive-value="PAUSED"
              inline-prompt
              active-text="启"
              inactive-text="停"
              :disabled="!!row.finished"
              style="margin-right: 8px"
              @change="handleToggleStatus(row)"
            />
            <el-popconfirm title="确认删除此定时任务？" @confirm="handleDelete(row.id)">
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in tasks" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ row.status === 'ACTIVE' ? '启用' : '暂停' }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ userName(row.userId) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Agent</span>
            <span>{{ agentName(row.agentId) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Cron</span>
            <span>{{ row.cronExpression }}<el-tag v-if="row.once" type="warning" size="small" style="margin-left: 4px">一次</el-tag></span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">上次</span>
            <el-tag v-if="row.lastExecutionStatus" :type="statusTagType(row.lastExecutionStatus)" size="small">
              {{ statusLabel(row.lastExecutionStatus) }}
            </el-tag>
            <span v-else class="text-muted">-</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">下次</span>
            <span>{{ formatDateTime(row.nextFireTime) }}</span>
          </div>
          <div class="mobile-card-actions">
            <el-switch
              v-model="row.status"
              active-value="ACTIVE"
              inactive-value="PAUSED"
              inline-prompt
              active-text="启"
              inactive-text="停"
              :disabled="!!row.finished"
              @change="handleToggleStatus(row)"
            />
            <el-popconfirm title="确认删除此定时任务？" @confirm="handleDelete(row.id)">
              <template #reference>
                <el-button type="danger" link>删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </el-card>
        <el-empty v-if="!loading && tasks.length === 0" description="暂无定时任务" />
      </div>

      <ResponsivePagination
        v-model:current-page="pageNum"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        class="pagination"
        @current-change="fetchTasks"
        @size-change="handleSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { ElMessage } from 'element-plus'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'

const { isMobile } = useBreakpoint()

interface ScheduledTask {
  id: number
  userId: number
  agentId: number
  sessionId: number
  name: string
  prompt: string
  cronExpression: string
  status: string
  once: number
  lastFireTime: string | null
  lastExecutionStatus: string | null
  nextFireTime: string | null
  fireCount: number
  finished: boolean | number
  finishedAt: string | null
  createdAt: string
}

const tasks = ref<ScheduledTask[]>([])
const loading = ref(false)
const pageNum = ref(1)
const pageSize = ref(20)
const total = ref(0)
const userNames = ref<Record<number, string>>({})
const agentNames = ref<Record<number, string>>({})
const userOptions = ref<Array<{ id: number; username?: string; displayName?: string }>>([])
const agentOptions = ref<Array<{ id: number; name?: string }>>([])

const filters = reactive({
  keyword: '',
  userId: null as number | null,
  agentId: null as number | null,
  status: '' as string,
  finished: null as boolean | null
})

function userName(id: number) {
  return userNames.value[id] || `用户 #${id}`
}

function agentName(id: number) {
  return agentNames.value[id] || `Agent #${id}`
}

async function fetchLookups() {
  try {
    const [usersRes, agentsRes] = await Promise.all([
      api.get('/admin/sessions/options/users'),
      api.get('/admin/sessions/options/agents')
    ])
    const nextUsers: Record<number, string> = {}
    for (const u of usersRes.data || []) {
      nextUsers[u.id] = u.displayName || u.username || `用户 #${u.id}`
    }
    userNames.value = nextUsers
    userOptions.value = usersRes.data || []
    const nextAgents: Record<number, string> = {}
    for (const a of agentsRes.data || []) {
      nextAgents[a.id] = a.name || `Agent #${a.id}`
    }
    agentNames.value = nextAgents
    agentOptions.value = agentsRes.data || []
  } catch {
    userNames.value = {}
    agentNames.value = {}
    userOptions.value = []
    agentOptions.value = []
  }
}

let fetchTasksSeq = 0
async function fetchTasks() {
  const seq = ++fetchTasksSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      pageNum: pageNum.value,
      pageSize: pageSize.value
    }
    if (filters.keyword.trim()) params.keyword = filters.keyword.trim()
    if (filters.userId != null) params.userId = filters.userId
    if (filters.agentId != null) params.agentId = filters.agentId
    if (filters.status) params.status = filters.status
    if (filters.finished != null) params.finished = filters.finished
    const { data } = await api.get('/scheduled-tasks/all', { params })
    if (seq !== fetchTasksSeq) return
    tasks.value = data.records
    total.value = data.total
  } catch {
    // interceptor handles toast
  } finally {
    if (seq === fetchTasksSeq) loading.value = false
  }
}

async function handleToggleStatus(task: ScheduledTask) {
  try {
    await api.put(`/scheduled-tasks/${task.id}`, { status: task.status })
    ElMessage.success(task.status === 'ACTIVE' ? '已启用' : '已暂停')
  } catch {
    // revert on error
    task.status = task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'
  }
}

async function handleDelete(id: number) {
  try {
    await api.delete(`/scheduled-tasks/${id}`)
    ElMessage.success('已删除')
    fetchTasks()
  } catch {
    // interceptor handles toast
  }
}

function handleSearch() {
  pageNum.value = 1
  fetchTasks()
}

function handleReset() {
  filters.keyword = ''
  filters.userId = null
  filters.agentId = null
  filters.status = ''
  filters.finished = null
  pageNum.value = 1
  fetchTasks()
}

function handleSizeChange() {
  pageNum.value = 1
  fetchTasks()
}

function statusTagType(status: string) {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'SKIPPED': return 'warning'
    case 'QUEUED': return 'primary'
    default: return 'info'
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'COMPLETED': return '成功'
    case 'FAILED': return '失败'
    case 'SKIPPED': return '跳过'
    case 'QUEUED': return '排队中'
    default: return status
  }
}

onMounted(() => {
  fetchLookups()
  fetchTasks()
})
</script>

<style scoped>
.scheduled-tasks {
  width: 100%;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.search-form {
  margin-bottom: 8px;
}
.text-muted {
  color: var(--el-text-color-secondary);
}
</style>
