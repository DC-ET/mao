<template>
  <div class="scheduled-tasks">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>定时任务管理</span>
        </div>
      </template>

      <el-table :data="tasks" stripe v-loading="loading">
        <template #empty>
          <el-empty description="暂无定时任务" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="任务名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="userId" label="用户ID" width="90" />
        <el-table-column prop="agentId" label="Agent ID" width="90" />
        <el-table-column prop="cronExpression" label="Cron 表达式" width="150" />
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
              :title="row.finishedAt ? `完结于 ${row.finishedAt}` : '已完结'"
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
        <el-table-column prop="lastFireTime" label="上次触发" width="170" />
        <el-table-column prop="nextFireTime" label="下次触发" width="170" />
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-switch
              v-model="row.status"
              active-value="ACTIVE"
              inactive-value="PAUSED"
              inline-prompt
              active-text="启"
              inactive-text="停"
              :disabled="row.finished"
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

      <el-pagination
        v-if="total > pageSize"
        class="pagination"
        :current-page="pageNum"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="handlePageChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../../api'
import { ElMessage } from 'element-plus'

interface ScheduledTask {
  id: number
  userId: number
  agentId: number
  sessionId: number
  name: string
  prompt: string
  cronExpression: string
  status: string
  lastFireTime: string | null
  lastExecutionStatus: string | null
  nextFireTime: string | null
  fireCount: number
  finished: boolean
  finishedAt: string | null
  createdAt: string
}

const tasks = ref<ScheduledTask[]>([])
const loading = ref(false)
const pageNum = ref(1)
const pageSize = ref(20)
const total = ref(0)

async function fetchTasks() {
  loading.value = true
  try {
    const { data } = await api.get('/scheduled-tasks/all', {
      params: { pageNum: pageNum.value, pageSize: pageSize.value }
    })
    tasks.value = data.records
    total.value = data.total
  } catch {
    // interceptor handles toast
  } finally {
    loading.value = false
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

function handlePageChange(page: number) {
  pageNum.value = page
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

onMounted(fetchTasks)
</script>

<style scoped>
.scheduled-tasks {
  padding: 20px;
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
.text-muted {
  color: var(--el-text-color-secondary);
}
</style>
