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
          <el-select v-model="filters.type" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
            <el-option label="系统" value="SYSTEM" />
            <el-option label="任务" value="TASK" />
            <el-option label="模型" value="MODEL" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.isRead" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
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
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ typeLabel(row.type) }}</el-tag>
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

      <el-pagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="fetchNotifications"
        @size-change="handleSizeChange"
      />
    </el-card>

    <ResponsiveDialog v-if="dialogVisible" v-model="dialogVisible" title="发布通知" width="520px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="80px">
        <el-form-item label="类型" prop="type">
          <el-select v-model="form.type" style="width: 100%">
            <el-option label="系统" value="SYSTEM" />
            <el-option label="任务" value="TASK" />
            <el-option label="模型" value="MODEL" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="4" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="saveNotification">发布</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

const loading = ref(false)
const submitting = ref(false)
const notifications = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const dialogVisible = ref(false)
const formRef = ref<FormInstance>()
const filters = reactive({
  type: '',
  isRead: undefined as number | undefined
})
const form = reactive({
  type: 'SYSTEM',
  title: '',
  content: ''
})

const formRules: FormRules = {
  type: [{ required: true, message: '请选择类型', trigger: 'change' }],
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入内容', trigger: 'blur' }]
}

const TYPE_LABELS: Record<string, string> = {
  SYSTEM: '系统',
  TASK: '任务',
  MODEL: '模型'
}

function typeLabel(type: string) {
  return TYPE_LABELS[type] || type
}

async function fetchNotifications() {
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.type) params.type = filters.type
    if (filters.isRead !== undefined) params.isRead = filters.isRead
    const { data } = await api.get('/notifications', { params })
    notifications.value = data?.records || []
    total.value = data?.total || 0
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
  if (submitting.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await api.post('/notifications', form)
    ElMessage.success('通知已发布')
    dialogVisible.value = false
    fetchNotifications()
  } finally {
    submitting.value = false
  }
}

async function markRead(row: any) {
  await api.patch(`/notifications/${row.id}/read`)
  ElMessage.success('已标记为已读')
  fetchNotifications()
}

function handleSearch() {
  currentPage.value = 1
  fetchNotifications()
}

function handleReset() {
  filters.type = ''
  filters.isRead = undefined
  currentPage.value = 1
  fetchNotifications()
}

function handleSizeChange() {
  currentPage.value = 1
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

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
