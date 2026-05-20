<template>
  <div class="model-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>模型配置</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            添加模型
          </el-button>
        </div>
      </template>

      <el-table :data="models" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="provider" label="供应商" width="120" />
        <el-table-column prop="modelId" label="模型标识" width="150" />
        <el-table-column prop="baseUrl" label="API 地址" min-width="200" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleTest(row)">测试</el-button>
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const models = ref<any[]>([])

async function fetchModels() {
  loading.value = true
  try {
    const { data } = await api.get('/models')
    models.value = data || []
  } finally {
    loading.value = false
  }
}

function handleCreate() {
  ElMessage.info('添加模型功能开发中')
}

function handleEdit(row: any) {
  ElMessage.info(`编辑模型: ${row.name}`)
}

async function handleTest(row: any) {
  try {
    await api.post(`/models/${row.id}/test`)
    ElMessage.success('模型连通性测试成功')
  } catch {
    // Error handled by interceptor
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除模型 "${row.name}" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/models/${row.id}`)
    ElMessage.success('删除成功')
    fetchModels()
  } catch {
    // Cancelled
  }
}

onMounted(fetchModels)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
