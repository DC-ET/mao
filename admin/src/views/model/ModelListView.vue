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

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键词">
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="名称 / 模型标识 / 供应商"
            style="width: 220px"
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item label="供应商">
          <el-select v-model="filters.provider" clearable filterable placeholder="全部供应商" style="width: 150px" @change="handleSearch">
            <el-option v-for="provider in providerOptions" :key="provider" :label="provider" :value="provider" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="启用" :value="1" />
            <el-option label="禁用" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item label="视觉">
          <el-select v-model="filters.supportsVision" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="支持" :value="1" />
            <el-option label="不支持" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认">
          <el-select v-model="filters.isDefault" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="默认" :value="1" />
            <el-option label="非默认" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="models" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" class="hide-on-mobile" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="provider" label="供应商" width="120" />
        <el-table-column prop="modelId" label="模型标识" width="150" class="hide-on-mobile" />
        <el-table-column prop="baseUrl" label="API 地址" min-width="200" show-overflow-tooltip class="hide-on-mobile" />
        <el-table-column label="上下文窗口" width="120" align="right" class="hide-on-mobile">
          <template #default="{ row }">
            {{ row.contextWindowTokens ? row.contextWindowTokens.toLocaleString() : '-' }}
          </template>
        </el-table-column>
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
        <el-table-column label="调用消息" width="100" align="right" class="hide-on-mobile">
          <template #default="{ row }">{{ modelStat(row.id).messageCount || 0 }}</template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleTest(row)">测试</el-button>
            <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button
              :type="row.status === 1 ? 'danger' : 'success'"
              link
              size="small"
              @click="handleToggleStatus(row)"
            >
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
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
import { reactive, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import ModelFormDialog from './ModelFormDialog.vue'

const loading = ref(false)
const models = ref<any[]>([])
const modelStats = ref<any[]>([])
const providerOptions = ref<string[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const dialogVisible = ref(false)
const currentModel = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')
const filters = reactive<{
  keyword: string
  provider: string
  status?: number
  supportsVision?: number
  isDefault?: number
}>({
  keyword: '',
  provider: '',
  status: undefined,
  supportsVision: undefined,
  isDefault: undefined
})

async function fetchModels() {
  loading.value = true
  try {
    const params: Record<string, string | number> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.keyword) params.keyword = filters.keyword
    if (filters.provider) params.provider = filters.provider
    if (filters.status !== undefined) params.status = filters.status
    if (filters.supportsVision !== undefined) params.supportsVision = filters.supportsVision
    if (filters.isDefault !== undefined) params.isDefault = filters.isDefault

    const [{ data }, summaryRes] = await Promise.all([
      api.get('/models', { params }),
      api.get('/admin/analytics/summary')
    ])
    models.value = data?.records || []
    modelStats.value = summaryRes.data?.modelStats || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function modelStat(id: number) {
  return modelStats.value.find(stat => stat.modelId === id) || {}
}

async function fetchProviderOptions() {
  const { data } = await api.get('/models/providers')
  providerOptions.value = data || []
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

function handleSearch() {
  currentPage.value = 1
  fetchModels()
}

function handleReset() {
  filters.keyword = ''
  filters.provider = ''
  filters.status = undefined
  filters.supportsVision = undefined
  filters.isDefault = undefined
  handleSearch()
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
    // Step back a page if we just emptied the current page, so we never land on a blank page.
    const remainingOnPage = models.value.length - 1
    const maxPage = Math.max(1, Math.ceil((total.value - 1) / pageSize.value))
    if (remainingOnPage === 0 && currentPage.value > maxPage) {
      currentPage.value = maxPage
    }
    fetchModels()
  } catch {
    // Cancelled
  }
}

async function handleToggleStatus(row: any) {
  const enable = row.status !== 1
  const actionText = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确定要${actionText}模型 \"${row.name}\" 吗？`, '确认', {
      type: enable ? 'success' : 'warning'
    })
    await api.patch(`/models/${row.id}/status`, { status: enable ? 1 : 0 })
    ElMessage.success(`${actionText}成功`)
    fetchModels()
  } catch {
    // Cancelled or error handled by interceptor
  }
}

onMounted(() => {
  fetchProviderOptions()
  fetchModels()
})
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

.search-form {
  margin-bottom: 16px;
}
</style>
