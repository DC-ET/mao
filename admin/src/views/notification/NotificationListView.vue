<template>
  <div class="notification-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>通知管理</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            发布通知
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="类型">
          <el-select v-model="filters.type" clearable placeholder="全部" style="width: 130px">
            <el-option label="SYSTEM" value="SYSTEM" />
            <el-option label="TASK" value="TASK" />
            <el-option label="MODEL" value="MODEL" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.isRead" clearable placeholder="全部" style="width: 120px">
            <el-option label="未读" :value="0" />
            <el-option label="已读" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="notifications" v-loading="loading" stripe>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" />
        <el-table-column prop="content" label="内容" min-width="260" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.isRead === 1 ? 'info' : 'warning'" size="small">
              {{ row.isRead === 1 ? '已读' : '未读' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button type="primary" link size="small" :disabled="row.isRead === 1" @click="markRead(row)">标记已读</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="发布通知" width="520px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option label="SYSTEM" value="SYSTEM" />
            <el-option label="TASK" value="TASK" />
            <el-option label="MODEL" value="MODEL" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="4" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveNotification">发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const notifications = ref<any[]>([])
const dialogVisible = ref(false)
const filters = reactive({
  type: '',
  isRead: undefined as number | undefined
})
const form = reactive({
  type: 'SYSTEM',
  title: '',
  content: ''
})

async function fetchNotifications() {
  loading.value = true
  try {
    const params: Record<string, unknown> = { page: 1, size: 50 }
    if (filters.type) params.type = filters.type
    if (filters.isRead !== undefined) params.isRead = filters.isRead
    const { data } = await api.get('/notifications', { params })
    notifications.value = data?.records || []
  } finally {
    loading.value = false
  }
}

function handleCreate() {
  form.type = 'SYSTEM'
  form.title = ''
  form.content = ''
  dialogVisible.value = true
}

async function saveNotification() {
  await api.post('/notifications', form)
  ElMessage.success('通知已发布')
  dialogVisible.value = false
  fetchNotifications()
}

async function markRead(row: any) {
  await api.patch(`/notifications/${row.id}/read`)
  ElMessage.success('已标记为已读')
  fetchNotifications()
}

function handleSearch() {
  fetchNotifications()
}

function handleReset() {
  filters.type = ''
  filters.isRead = undefined
  fetchNotifications()
}

onMounted(fetchNotifications)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  margin-bottom: 16px;
}
</style>
