<template>
  <div class="agent-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent 列表</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            创建 Agent
          </el-button>
        </div>
      </template>

      <!-- Search -->
      <el-form :inline="true" class="search-form">
        <el-form-item label="搜索">
          <el-input
            v-model="searchQuery"
            placeholder="Agent 名称"
            clearable
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item label="标签">
          <el-select v-model="tagFilter" placeholder="全部标签" clearable style="width: 150px" @change="handleTagFilterChange">
            <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
        </el-form-item>
      </el-form>

      <!-- Table -->
      <el-table :data="filteredAgents" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="80" class-name="hide-on-mobile" label-class-name="hide-on-mobile" />
        <el-table-column prop="name" label="名称" min-width="120">
          <template #default="{ row }">
            <span>{{ row.name }}</span>
            <el-tag v-if="row.isDefault" type="warning" size="small" style="margin-left: 8px">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column label="标签" min-width="180" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">
            <el-tag
              v-for="tag in row.tags"
              :key="tag"
              size="small"
              class="tag-item"
            >{{ tag }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Skills" width="110" align="right" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.skillNames?.length || 0 }}</template>
        </el-table-column>
        <el-table-column label="经验数" width="90" align="right" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.experiences?.length || 0 }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180" class-name="hide-on-mobile" label-class-name="hide-on-mobile" />
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination -->
      <el-pagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="fetchAgents"
        @size-change="handleSizeChange"
      />
    </el-card>

    <AgentFormDialog
      v-model:visible="dialogVisible"
      :agent-data="currentAgent"
      :mode="dialogMode"
      @saved="fetchAgents"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import AgentFormDialog from './AgentFormDialog.vue'

const loading = ref(false)
const allAgents = ref<any[]>([])
const searchQuery = ref('')
const tagFilter = ref('')
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)
const dialogVisible = ref(false)
const currentAgent = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')

async function fetchAgents() {
  loading.value = true
  try {
    const { data } = await api.get('/agents', {
      params: { keyword: searchQuery.value }
    })
    allAgents.value = data || []
  } finally {
    loading.value = false
  }
}

const tagOptions = computed(() => {
  const tags = new Set<string>()
  allAgents.value.forEach(agent => (agent.tags || []).forEach((tag: string) => tags.add(tag)))
  return Array.from(tags)
})

// Filter by tag on the full dataset, then paginate client-side
const filteredAgents = computed(() => {
  const list = tagFilter.value
    ? allAgents.value.filter(agent => (agent.tags || []).includes(tagFilter.value))
    : allAgents.value
  total.value = list.length
  const start = (currentPage.value - 1) * pageSize.value
  return list.slice(start, start + pageSize.value)
})

function handleSearch() {
  currentPage.value = 1
  fetchAgents()
}

function handleTagFilterChange() {
  currentPage.value = 1
}

function handleSizeChange() {
  currentPage.value = 1
}

function handleCreate() {
  dialogMode.value = 'create'
  currentAgent.value = null
  dialogVisible.value = true
}

async function loadAgentDetail(id: number) {
  const { data } = await api.get(`/agents/${id}`)
  return data
}

async function handleCopy(row: any) {
  const detail = await loadAgentDetail(row.id)
  dialogMode.value = 'copy'
  currentAgent.value = detail
  dialogVisible.value = true
}

async function handleEdit(row: any) {
  const detail = await loadAgentDetail(row.id)
  dialogMode.value = 'edit'
  currentAgent.value = detail
  dialogVisible.value = true
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除 Agent \"${row.name}\" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/agents/${row.id}`)
    ElMessage.success('删除成功')
    fetchAgents()
  } catch {
    // Cancelled
  }
}

onMounted(fetchAgents)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  margin-bottom: 20px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}

.tag-item {
  margin-right: 4px;
  margin-bottom: 2px;
}
</style>
