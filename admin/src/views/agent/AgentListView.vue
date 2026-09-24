<template>
  <div class="agent-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent 列表</span>
          <el-button v-if="canWrite" type="primary" @click="handleCreate">
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
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" clearable placeholder="全部" style="width: 120px" @change="handleStatusFilter">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="!isMobile" :data="filteredAgents" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="72" />
        <el-table-column prop="name" label="名称" width="240" class-name="agent-name-col">
          <template #default="{ row }">
            <div class="agent-identity">
              <el-avatar :size="32" :src="resolveAgentAvatarUrl(row.avatarUrl)" shape="square">{{ row.name?.slice(0, 1) || 'A' }}</el-avatar>
              <span class="agent-name" :title="row.name">{{ row.name }}</span>
              <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="88">
          <template #default="{ row }">
            <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
              {{ row.enabled === false ? '停用' : '启用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建人" width="120" show-overflow-tooltip class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.creatorName || '-' }}</template>
        </el-table-column>
        <el-table-column label="Skills" width="84" align="right">
          <template #default="{ row }">{{ row.skillNames?.length || 0 }}</template>
        </el-table-column>
        <el-table-column label="经验数" width="84" align="right">
          <template #default="{ row }">{{ row.experiences?.length || 0 }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="178" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <div v-if="canWrite" class="row-actions">
              <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link size="small" @click="historyAgent = row">提示词版本</el-button>
              <el-tooltip v-if="row.isDefault && row.enabled !== false" content="默认 Agent 不可停用" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link size="small" disabled>停用</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else
                :type="row.enabled === false ? 'success' : 'danger'"
                link
                size="small"
                @click="handleToggleEnabled(row)"
              >{{ row.enabled === false ? '启用' : '停用' }}</el-button>
              <el-tooltip v-if="row.isDefault" content="默认 Agent 不可删除" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link size="small" disabled>删除</el-button>
                </span>
              </el-tooltip>
              <el-button v-else type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
            </div>
            <span v-else class="op-muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in filteredAgents" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <el-avatar :size="32" :src="resolveAgentAvatarUrl(row.avatarUrl)" shape="square">{{ row.name?.slice(0, 1) || 'A' }}</el-avatar>
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
            <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
              {{ row.enabled === false ? '停用' : '启用' }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">描述</span>
            <span>{{ row.description || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Skills</span>
            <span>{{ row.skillNames?.length || 0 }}</span>
          </div>
          <div class="mobile-card-actions">
            <template v-if="canWrite">
              <el-button type="primary" link @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link @click="historyAgent = row">提示词版本</el-button>
              <el-tooltip v-if="row.isDefault && row.enabled !== false" content="默认 Agent 不可停用" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link disabled>停用</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else
                :type="row.enabled === false ? 'success' : 'danger'"
                link
                @click="handleToggleEnabled(row)"
              >{{ row.enabled === false ? '启用' : '停用' }}</el-button>
              <el-tooltip v-if="row.isDefault" content="默认 Agent 不可删除" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link disabled>删除</el-button>
                </span>
              </el-tooltip>
              <el-button v-else type="danger" link @click="handleDelete(row)">删除</el-button>
            </template>
          </div>
        </el-card>
        <el-empty v-if="!loading && filteredAgents.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="fetchAgents"
        @size-change="handleSizeChange"
      />
    </el-card>

    <AgentPromptHistoryDialog
      v-if="historyAgent"
      :agent-id="historyAgent.id"
      :agent-name="historyAgent.name"
      @close="historyAgent = null"
      @restored="fetchAgents"
    />
    <AgentFormDialog
      v-if="dialogVisible"
      :visible="true"
      :agent-data="currentAgent"
      :mode="dialogMode"
      @update:visible="dialogVisible = $event"
      @saved="fetchAgents"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { resolveAgentAvatarUrl } from '../../utils/agent-avatar'
import { formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import AgentFormDialog from './AgentFormDialog.vue'
import AgentPromptHistoryDialog from './AgentPromptHistoryDialog.vue'

const historyAgent = ref<{ id: number; name: string } | null>(null)

const { isMobile } = useBreakpoint()

const loading = ref(false)
const loadingDetail = ref(false)
const allAgents = ref<any[]>([])
const searchQuery = ref('')
const statusFilter = ref('')
const currentPage = ref(1)
const pageSize = ref(10)
const dialogVisible = ref(false)
const currentAgent = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

let fetchAgentsSeq = 0
async function fetchAgents() {
  const seq = ++fetchAgentsSeq
  loading.value = true
  try {
    const { data } = await api.get('/agents', {
      params: { keyword: searchQuery.value, includeDisabled: true }
    })
    if (seq !== fetchAgentsSeq) return
    allAgents.value = data || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchAgentsSeq) loading.value = false
  }
}

const matchedAgents = computed(() => {
  if (statusFilter.value === 'enabled') return allAgents.value.filter((row) => row.enabled !== false)
  if (statusFilter.value === 'disabled') return allAgents.value.filter((row) => row.enabled === false)
  return allAgents.value
})
const total = computed(() => matchedAgents.value.length)
const filteredAgents = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return matchedAgents.value.slice(start, start + pageSize.value)
})

function handleSearch() {
  currentPage.value = 1
  fetchAgents()
}

function handleStatusFilter() {
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
  if (loadingDetail.value) return
  loadingDetail.value = true
  try {
    const detail = await loadAgentDetail(row.id)
    dialogMode.value = 'copy'
    currentAgent.value = detail
    dialogVisible.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingDetail.value = false
  }
}

async function handleEdit(row: any) {
  if (loadingDetail.value) return
  loadingDetail.value = true
  try {
    const detail = await loadAgentDetail(row.id)
    dialogMode.value = 'edit'
    currentAgent.value = detail
    dialogVisible.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingDetail.value = false
  }
}

async function handleToggleEnabled(row: any) {
  const enable = row.enabled === false
  const actionText = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(
      enable
        ? `确定要启用 Agent「${row.name}」吗？启用后会重新出现在使用侧的 Agent 列表中。`
        : `确定要停用 Agent「${row.name}」吗？停用后使用侧的 Agent 列表不再显示，也不能用它新建会话。已有会话可以继续。`,
      '确认',
      { type: enable ? 'success' : 'warning' }
    )
    await api.patch(`/agents/${row.id}/enabled`, { enabled: enable })
    ElMessage.success(`${actionText}成功`)
    fetchAgents()
  } catch {
    // Cancelled or error handled by interceptor
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除 Agent \"${row.name}\" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/agents/${row.id}`)
    ElMessage.success('删除成功')
    // 当前页删空时回退页码，避免停留在空白页
    const maxPage = Math.max(1, Math.ceil((total.value - 1) / pageSize.value))
    if (currentPage.value > maxPage) currentPage.value = maxPage
    fetchAgents()
  } catch {
    // Cancelled
  }
}

onMounted(fetchAgents)
</script>

<style scoped>
.agent-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.agent-identity .el-avatar,
.agent-identity .el-tag {
  flex-shrink: 0;
}
.agent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}
:deep(.agent-name-col .cell) {
  overflow-wrap: normal;
  word-break: keep-all;
}
.row-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
}
.row-actions :deep(.el-button) {
  margin-left: 0;
}
.row-actions .disabled-btn-wrap,
.row-actions :deep(.el-tooltip__trigger) {
  flex-shrink: 0;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.op-muted {
  color: var(--el-text-color-secondary);
}

.disabled-btn-wrap {
  display: inline-flex;
  margin: 0;
}

.search-form {
  margin-bottom: 20px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
