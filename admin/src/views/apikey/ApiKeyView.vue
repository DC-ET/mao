<template>
  <div class="api-key">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>API Key 管理</span>
          <el-button type="primary" @click="showCreateDialog = true">创建 API Key</el-button>
        </div>
      </template>

      <el-table :data="apiKeys" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="apiKey" label="API Key" min-width="200">
          <template #default="{ row }">
            <span class="key-text">{{ row.apiKey }}</span>
            <el-button type="primary" link size="small" @click="copyKey(row.apiKey)">复制</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="rateLimit" label="限流(/分钟)" width="120" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastUsedAt" label="最后使用" width="180" />
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button type="danger" link size="small" @click="handleRevoke(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Create Dialog -->
    <el-dialog v-model="showCreateDialog" title="创建 API Key" width="400px">
      <el-form :model="createForm" label-width="100px">
        <el-form-item label="名称">
          <el-input v-model="createForm.name" placeholder="如: 生产环境" />
        </el-form-item>
        <el-form-item label="限流(/分钟)">
          <el-input-number v-model="createForm.rateLimit" :min="1" :max="10000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreate" :loading="creating">创建</el-button>
      </template>
    </el-dialog>

    <!-- Show Created Key Dialog -->
    <el-dialog v-model="showKeyDialog" title="API Key 已创建" width="500px">
      <el-alert type="warning" :closable="false" style="margin-bottom: 16px">
        请立即复制保存此 Key，关闭后将无法再次查看完整内容。
      </el-alert>
      <el-input v-model="createdKey" readonly>
        <template #append>
          <el-button @click="copyKey(createdKey)">复制</el-button>
        </template>
      </el-input>
      <template #footer>
        <el-button type="primary" @click="showKeyDialog = false">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const apiKeys = ref<any[]>([])
const showCreateDialog = ref(false)
const showKeyDialog = ref(false)
const creating = ref(false)
const createdKey = ref('')

const createForm = ref({
  name: '',
  rateLimit: 100
})

async function fetchKeys() {
  loading.value = true
  try {
    const { data } = await api.get('/api-keys')
    apiKeys.value = data || []
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!createForm.value.name) {
    ElMessage.warning('请输入名称')
    return
  }
  creating.value = true
  try {
    const { data } = await api.post('/api-keys', createForm.value) as any
    createdKey.value = data?.apiKey || ''
    showCreateDialog.value = false
    showKeyDialog.value = true
    createForm.value = { name: '', rateLimit: 100 }
    fetchKeys()
  } finally {
    creating.value = false
  }
}

async function handleRevoke(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除 API Key "${row.name}" 吗？`, '确认', { type: 'warning' })
    await api.delete(`/api-keys/${row.id}`)
    ElMessage.success('已删除')
    fetchKeys()
  } catch {
    // Cancelled
  }
}

function copyKey(key: string) {
  navigator.clipboard.writeText(key)
  ElMessage.success('已复制到剪贴板')
}

onMounted(fetchKeys)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.key-text {
  font-family: monospace;
  margin-right: 8px;
}
</style>
