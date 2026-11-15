<template>
  <div class="agent-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent 列表</span>
          <div v-if="canWrite" class="header-actions">
            <el-button type="primary" @click="handleCreate">
              <el-icon><Plus /></el-icon>
              创建 Agent
            </el-button>
          </div>
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
        <el-form-item label="默认模型">
          <el-select
            v-model="modelFilter"
            clearable
            filterable
            placeholder="全部"
            style="width: 200px"
            @change="handleModelFilter"
          >
            <el-option v-for="model in modelOptions" :key="model.id" :label="model.name" :value="model.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Git 凭据域">
          <el-select v-model="gitDomainFilter" clearable placeholder="全部" style="width: 120px" @change="handleGitDomainFilter">
            <el-option label="未配置" value="missing" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="allClientHidden"
        type="warning"
        show-icon
        :closable="false"
        class="client-hidden-alert"
        title="当前没有客户端可见的 Agent"
        description="客户端新建会话将显示「暂无可用智能体」。请在任一 Agent 的编辑页开启「客户端可见」。"
      />

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
        <el-table-column label="默认模型" width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.defaultModelId == null" class="muted-text">跟随全局默认</span>
            <span v-else>{{ resolveModelName(row.defaultModelId) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
              {{ row.enabled === false ? '停用' : '启用' }}
            </el-tag>
            <el-tag v-if="row.clientVisible === false" type="warning" size="small" class="client-hidden-tag">
              仅管理端
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建人" width="120" show-overflow-tooltip class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.creatorName || '-' }}</template>
        </el-table-column>
        <el-table-column label="能力概览" width="170">
          <template #default="{ row }">
            <el-tooltip placement="top">
              <template #content>
                <div>技能：{{ capabilityText(row.skillNames) }}</div>
                <div>MCP：{{ capabilityText(resolveNames(row.mcpServerIds, mcpNameById)) }}</div>
                <div>自定义工具：{{ capabilityText(resolveNames(row.httpToolIds, toolNameById)) }}</div>
                <div>Git 域：{{ gitDomainText(row.gitAllowedDomains) }}</div>
              </template>
              <span>{{ capabilitySummary(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="经验数" width="84" align="right">
          <template #default="{ row }">{{ row.experiences?.length || 0 }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="178" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }">
            <div v-if="canWrite" class="row-actions">
              <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link size="small" @click="openExperienceLibrary(row)">经验库</el-button>
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
            <el-tag v-if="row.clientVisible === false" type="warning" size="small">仅管理端</el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">描述</span>
            <span>{{ row.description || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">默认模型</span>
            <span v-if="row.defaultModelId == null" class="muted-text">跟随全局默认</span>
            <span v-else>{{ resolveModelName(row.defaultModelId) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">能力概览</span>
            <span>{{ capabilitySummary(row) }}</span>
          </div>
          <div class="mobile-card-actions">
            <template v-if="canWrite">
              <el-button type="primary" link @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link @click="openExperienceLibrary(row)">经验库</el-button>
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

    <AgentFormDialog
      v-if="dialogVisible"
      :visible="true"
      :agent-data="currentAgent"
      :mode="dialogMode"
      @update:visible="dialogVisible = $event"
      @saved="refreshAgentData"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onActivated, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { api } from '../../api'
import { resolveAgentAvatarUrl } from '../../utils/agent-avatar'
import { formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import AgentFormDialog from './AgentFormDialog.vue'

const { isMobile } = useBreakpoint()

const route = useRoute()
const router = useRouter()

/** 经验库入口跳转独立管理页（2026-11-13 方案：弹窗升级为三栏页面），带 agentId 直达。 */
function openExperienceLibrary(row: { id: number }): void {
  router.push({ path: '/experience', query: { agentId: String(row.id) } })
}

const loading = ref(false)
const loadingDetail = ref(false)
const allAgents = ref<any[]>([])
/** 全量 Agent（不带 keyword）：只用于客户端可见性提示，避免搜索过滤后误报。 */
const visibilityAgents = ref<any[]>([])
const searchQuery = ref('')
const statusFilter = ref('')
/**
 * 按默认模型筛选（纯前端，agent 列表本就全量拉取）。
 * 注意 element-plus clearable select 清空时置 undefined 而非 ''，两种空值都要放行。
 */
const modelFilter = ref<number | '' | undefined>('')
/** Git 凭据域筛选（技术方案 2026-11-06）：'missing'=只看未配置（后端过滤），其余为空不过滤。 */
const gitDomainFilter = ref<'' | 'missing'>('')
const modelOptions = ref<Array<{ id: number; name: string }>>([])
const currentPage = ref(1)
const pageSize = ref(10)
const dialogVisible = ref(false)
const currentAgent = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

/** 资源名映射（能力概览 tooltip 用）：含停用行，未命中 id 以 #id 兜底。 */
const mcpNameById = ref<Map<number, string>>(new Map())
const toolNameById = ref<Map<number, string>>(new Map())

/** 全量视角（不受搜索/状态筛选影响）：全部 Agent 都被设为客户端不可见时给出提示。 */
const allClientHidden = computed(
  () => visibilityAgents.value.length > 0 && visibilityAgents.value.every(agent => agent.clientVisible === false),
)

let fetchAgentsSeq = 0
async function fetchAgents() {
  const seq = ++fetchAgentsSeq
  loading.value = true
  try {
    const { data } = await api.get('/agents', {
      params: {
        keyword: searchQuery.value,
        includeDisabled: true,
        // 「未配置」筛选走后端（git_allowed_domains IS NULL），状态/模型筛选仍是前端过滤
        ...(gitDomainFilter.value === 'missing' ? { missingGitDomains: true } : {})
      }
    })
    if (seq !== fetchAgentsSeq) return
    allAgents.value = data || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchAgentsSeq) loading.value = false
  }
}

let fetchVisibilitySeq = 0
/** 单独拉全量列表：keyword 过滤后的 allAgents 不能用来判断「全局是否都不可见」。 */
async function fetchVisibilityAgents() {
  const seq = ++fetchVisibilitySeq
  try {
    const { data } = await api.get('/agents', { params: { includeDisabled: true } })
    if (seq !== fetchVisibilitySeq) return
    visibilityAgents.value = data || []
  } catch { /* 拦截器已提示失败；保留上一次可见性判断 */ }
}

/** 列表与可见性提示的数据源一起刷新（增删改 / 激活页面时使用）。 */
function refreshAgentData() {
  fetchAgents()
  fetchVisibilityAgents()
}

const matchedAgents = computed(() => {
  let rows = allAgents.value
  if (statusFilter.value === 'enabled') rows = rows.filter((row) => row.enabled !== false)
  else if (statusFilter.value === 'disabled') rows = rows.filter((row) => row.enabled === false)
  // undefined（clearable 清空）与 '' 同为「不过滤」；VO 的 defaultModelId 只会是 number | null
  if (modelFilter.value != null && modelFilter.value !== '') {
    rows = rows.filter((row) => row.defaultModelId === modelFilter.value)
  }
  return rows
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

function handleModelFilter() {
  currentPage.value = 1
}

function handleGitDomainFilter() {
  currentPage.value = 1
  fetchAgents()
}

/** 默认模型列：启用模型显示名称；指向已停用 / 已删除模型时以 #id 兜底。 */
function resolveModelName(modelId: number): string {
  const found = modelOptions.value.find((model) => model.id === modelId)
  return found ? found.name : `#${modelId}（已停用）`
}

function resolveNames(ids: unknown, map: Map<number, string>): string[] {
  if (!Array.isArray(ids)) return []
  return ids
    .filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
    .map((id) => map.get(id) ?? `#${id}`)
}

function capabilityText(names: string[]): string {
  return names.length > 0 ? names.join('、') : '—'
}

/** 能力概览：Git 凭据域三态文案（null=未配置、[]=已禁止、非空=N 个域）。 */
function gitDomainText(domains: string[] | null | undefined): string {
  if (domains == null) return '未配置'
  if (domains.length === 0) return '已禁止'
  return `${domains.length} 个域`
}

function capabilitySummary(row: any): string {
  const skills = Array.isArray(row.skillNames) ? row.skillNames.length : 0
  const mcp = Array.isArray(row.mcpServerIds) ? row.mcpServerIds.length : 0
  const tools = Array.isArray(row.httpToolIds) ? row.httpToolIds.length : 0
  const parts: string[] = []
  if (skills > 0) parts.push(`技能 ${skills}`)
  if (mcp > 0) parts.push(`MCP ${mcp}`)
  if (tools > 0) parts.push(`工具 ${tools}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/**
 * 名称字典（fail-soft）：/models/active（默认模型列与筛选下拉）、
 * /mcp-servers 全量（含停用）、/admin/http-tools 第 1 页 size=100（含停用；
 * 超 100 个工具的极端场景以 #id 兜底）。任一失败置空 Map，不阻塞主列表。
 */
async function loadNameDictionaries() {
  const [modelsRes, mcpRes, toolsRes] = await Promise.all([
    api.get('/models/active').catch(() => null),
    api.get('/mcp-servers').catch(() => null),
    api.get('/admin/http-tools', { params: { page: 1, size: 100 } }).catch(() => null),
  ])
  const modelRows = Array.isArray(modelsRes?.data) ? modelsRes.data : []
  modelOptions.value = modelRows
    .filter((row: any) => Number.isInteger(row?.id))
    .map((row: any) => ({ id: Number(row.id), name: String(row.name ?? `#${row.id}`) }))
  mcpNameById.value = toNameMap(mcpRes?.data)
  toolNameById.value = toNameMap(toolsRes?.data?.records)
}

function toNameMap(rows: unknown): Map<number, string> {
  const map = new Map<number, string>()
  if (!Array.isArray(rows)) return map
  for (const row of rows as Array<Record<string, unknown>>) {
    if (Number.isInteger(row?.id)) map.set(Number(row.id), String(row?.displayName ?? row?.name ?? `#${row.id}`))
  }
  return map
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
    refreshAgentData()
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
    refreshAgentData()
  } catch {
    // Cancelled
  }
}

// 支持 RelatedAgentsPopover 的 ?keyword= 直跳预填（popover 点名 → 过滤后的列表页）。
// watch 而非只在 onMounted 读：Agent 页被 Layout 的 keep-alive 缓存，从其它页面带
// query 复活时只走路由变化、不走 onMounted；immediate 覆盖首次挂载。空 query 不清空
// 用户已输入的搜索词。
watch(() => route.query.keyword, (kw) => {
  if (typeof kw === 'string' && kw.trim() !== '') {
    searchQuery.value = kw.trim()
    currentPage.value = 1
    fetchAgents()
  }
}, { immediate: true })

onMounted(() => {
  void loadNameDictionaries()
  refreshAgentData()
})

let firstActivation = true
onActivated(() => {
  if (firstActivation) {
    firstActivation = false
    return
  }
  void loadNameDictionaries()
  refreshAgentData()
})
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
.client-hidden-alert {
  margin-bottom: 12px;
}
.client-hidden-tag {
  margin-left: 6px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0;
}
.header-actions :deep(.el-button + .el-button) {
  margin-left: 12px;
}
.op-muted {
  color: var(--el-text-color-secondary);
}

.muted-text {
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
