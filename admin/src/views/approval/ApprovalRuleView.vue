<template>
  <div class="approval-rule">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>审批规则</span>
          <el-button @click="fetchRules">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="用户">
          <el-select v-model="filters.userId" clearable filterable placeholder="全部用户" style="width: 180px" @change="handleSearch">
            <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="filters.ruleType" clearable placeholder="全部" style="width: 150px" @change="handleSearch">
            <el-option label="命令前缀" value="SHELL_PREFIX" />
            <el-option label="完整命令" value="SHELL_EXACT" />
            <el-option label="MCP 工具" value="MCP_TOOL" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.enabled" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="启用" :value="true" />
            <el-option label="停用" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="records" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="username" label="用户" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ row.username ?? `#${row.userId}` }}</template>
        </el-table-column>
        <el-table-column prop="scope" label="范围" width="80">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'SESSION' ? 'warning' : 'success'" size="small">
              {{ row.scope === 'SESSION' ? '会话' : '用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sessionTitle" label="所属会话" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.scope === 'SESSION' ? (row.sessionTitle ?? `#${row.sessionId}`) : '—' }}</template>
        </el-table-column>
        <el-table-column prop="ruleType" label="类型" width="100">
          <template #default="{ row }">{{ typeLabel(row.ruleType) }}</template>
        </el-table-column>
        <el-table-column prop="ruleValue" label="规则值" min-width="200" show-overflow-tooltip>
          <template #default="{ row }"><code class="rule-value">{{ row.ruleValue }}</code></template>
        </el-table-column>
        <el-table-column prop="hitCount" label="命中次数" width="90" align="right" />
        <el-table-column prop="lastHitAt" label="最近命中" width="160">
          <template #default="{ row }">{{ formatTime(row.lastHitAt) }}</template>
        </el-table-column>
        <el-table-column prop="enabled" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="160">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="fetchRules"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'

interface ApprovalRuleRow {
  id: number
  userId: number
  username: string | null
  scope: 'SESSION' | 'USER'
  sessionId: number | null
  sessionTitle: string | null
  ruleType: 'SHELL_PREFIX' | 'SHELL_EXACT' | 'MCP_TOOL'
  ruleValue: string
  hitCount: number
  lastHitAt: string | null
  enabled: boolean
  createdAt: string | null
}

const loading = ref(false)
const records = ref<ApprovalRuleRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = 20
const userOptions = ref<Array<{ id: number; username: string; displayName?: string | null }>>([])
const filters = ref({
  userId: undefined as number | undefined,
  ruleType: '' as '' | 'SHELL_PREFIX' | 'SHELL_EXACT' | 'MCP_TOOL',
  enabled: undefined as boolean | undefined
})

function typeLabel(t: string) {
  switch (t) {
    case 'SHELL_PREFIX': return '命令前缀'
    case 'SHELL_EXACT': return '完整命令'
    case 'MCP_TOOL': return 'MCP 工具'
    default: return t
  }
}

function formatTime(value?: string | null) {
  if (!value) return '—'
  return String(value).replace('T', ' ').slice(0, 19)
}

async function fetchUserOptions() {
  try {
    const { data } = await api.get('/admin/sessions/options/users')
    userOptions.value = data || []
  } catch { /* 拦截器已提示失败 */ }
}

let fetchSeq = 0
async function fetchRules() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = { page: currentPage.value, size: pageSize }
    if (filters.value.userId != null) params.userId = filters.value.userId
    if (filters.value.ruleType) params.type = filters.value.ruleType
    if (filters.value.enabled !== undefined) params.enabled = filters.value.enabled
    const { data } = await api.get('/admin/approval-rules', { params })
    if (seq !== fetchSeq) return
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败 */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchRules()
}

function handleReset() {
  filters.value.userId = undefined
  filters.value.ruleType = ''
  filters.value.enabled = undefined
  handleSearch()
}

onMounted(() => {
  fetchUserOptions()
  fetchRules()
})
</script>

<style scoped>
.approval-rule {
  padding: 0;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.search-form {
  margin-bottom: 4px;
}

.rule-value {
  font-family: monospace;
  font-size: 12px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
