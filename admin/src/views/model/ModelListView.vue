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
        <el-table-column label="视觉" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.supportsVision ? 'success' : 'info'" size="small">
              {{ row.supportsVision ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleTest(row)">测试</el-button>
            <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="fetchModels"
          @size-change="handleSizeChange"
        />
      </div>
    </el-card>

    <ModelFormDialog
      v-model:visible="dialogVisible"
      :model-data="currentModel"
      :mode="dialogMode"
      @saved="fetchModels"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import ModelFormDialog from './ModelFormDialog.vue'

const loading = ref(false)
const models = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const dialogVisible = ref(false)
const currentModel = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')

async function fetchModels() {
  loading.value = true
  try {
    const { data } = await api.get('/models', {
      params: {
        page: currentPage.value,
        size: pageSize.value
      }
    })
    models.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function handleCreate() {
  dialogMode.value = 'create'
  currentModel.value = null
  dialogVisible.value = true
}

async function loadModelDetail(id: number) {
  const { data } = await api.get(`/models/${id}`)
  return data
}

async function handleCopy(row: any) {
  const detail = await loadModelDetail(row.id)
  dialogMode.value = 'copy'
  currentModel.value = detail
  dialogVisible.value = true
}

async function handleEdit(row: any) {
  const detail = await loadModelDetail(row.id)
  dialogMode.value = 'edit'
  currentModel.value = detail
  dialogVisible.value = true
}

function handleSizeChange() {
  currentPage.value = 1
  fetchModels()
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
    await ElMessageBox.confirm(`确定要删除模型 \"${row.name}\" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/models/${row.id}`)
    ElMessage.success('删除成功')
    if (models.value.length === 1 && currentPage.value > 1) {
      currentPage.value -= 1
    }
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

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
