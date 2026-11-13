<template>
  <div class="memory-manage-panel">
    <el-alert
      class="manage-notice"
      :type="canManage ? 'info' : 'warning'"
      :closable="false"
      show-icon
      :title="canManage ? '记忆为用户个人数据，管理操作将记入审计日志' : '当前角色只读'"
      :description="canManage
        ? '记忆会注入用户后续会话的系统提示词；编辑、忽略、恢复、删除、代建均会记入审计日志。'
        : '记忆会注入用户后续会话的系统提示词；当前角色仅可查询，管理操作需要 memory:write 权限。'"
    />

    <el-card>
      <template #header>
        <div class="card-header">
          <span>记忆列表</span>
          <div class="header-actions">
            <el-button v-if="canManage" type="primary" @click="openCreateDialog">新增记忆</el-button>
            <el-button title="刷新" aria-label="刷新列表" @click="handleRefresh">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form" @submit.prevent>
        <!-- 定人模式（用户详情抽屉）：用户固定，不再提供用户筛选 -->
        <el-form-item v-if="!isFixed" label="用户">
          <el-select
            v-model="selectedUserId"
            filterable
            remote
            clearable
            :remote-method="searchFilterUsers"
            :loading="filterUserLoading"
            placeholder="搜索用户名 / 昵称"
            style="width: 200px"
            @change="onFilterChange"
          >
            <el-option v-for="u in filterUserOptions" :key="u.id" :label="userOptionLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input
            v-model="keywordFilter"
            placeholder="内容 / 项目标识 包含匹配"
            style="width: 200px"
            clearable
            @keyup.enter="handleSearch"
            @clear="onFilterChange"
          />
        </el-form-item>
        <el-form-item label="作用域">
          <el-select v-model="scopeFilter" clearable placeholder="全部" style="width: 110px" @change="onFilterChange">
            <el-option v-for="(label, value) in SCOPE_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" clearable placeholder="全部" style="width: 110px" @change="onFilterChange">
            <el-option v-for="(label, value) in STATUS_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="sourceFilter" clearable placeholder="全部" style="width: 110px" @change="onFilterChange">
            <el-option v-for="(label, value) in SOURCE_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目">
          <el-input
            v-model="projectKeyFilter"
            placeholder="项目标识精确匹配"
            style="width: 160px"
            clearable
            @keyup.enter="handleSearch"
            @clear="onFilterChange"
          />
        </el-form-item>
        <el-form-item label="更新时间">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            style="width: 240px"
            @change="onFilterChange"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="items" v-loading="loading" stripe>
        <el-table-column label="ID" prop="id" width="80" />
        <!-- 定人模式（用户详情抽屉）：整列用户即抽屉用户，不再重复展示 -->
        <el-table-column v-if="!isFixed" label="用户" width="160">
          <template #default="{ row }">
            <span>{{ row.displayName || row.username || `#${row.userId}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="作用域" width="90">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'PROJECT' ? 'warning' : 'info'" size="small">
              {{ scopeLabel(row.scope) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="项目" width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.projectKey || '-' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.content }}</template>
        </el-table-column>
        <el-table-column label="来源" width="80">
          <template #default="{ row }">
            <el-tag :type="row.source === 'AUTO' ? 'success' : 'info'" size="small">
              {{ sourceLabel(row.source) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源会话" width="100">
          <template #default="{ row }">{{ row.originSessionId != null ? `#${row.originSessionId}` : '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
            <el-button v-if="row.status === 'ACTIVE'" link type="warning" @click="toggleStatus(row, 'DISMISSED')">忽略</el-button>
            <el-button v-else link type="success" @click="toggleStatus(row, 'ACTIVE')">恢复</el-button>
            <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !canQuery" description="请选择用户或输入关键词跨用户检索" />
      <el-empty v-else-if="!loading && items.length === 0" description="无匹配记忆" />

      <ResponsivePagination
        class="pagination"
        v-model:currentPage="page"
        :page-size="pageSize"
        :total="total"
        @current-change="fetchList"
      />
    </el-card>

    <el-dialog v-model="editDialogVisible" title="编辑记忆" width="520px">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="用户">
          <span>{{ editTarget ? userDisplayName(editTarget) : '-' }}</span>
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="editForm.content"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="记忆内容（注入用户后续会话的系统提示词）"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="editForm.status">
            <el-radio value="ACTIVE">{{ STATUS_LABELS.ACTIVE }}</el-radio>
            <el-radio value="DISMISSED">{{ STATUS_LABELS.DISMISSED }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="createDialogVisible" title="新增记忆" width="520px">
      <el-form label-width="80px" @submit.prevent>
        <!-- 定人模式：目标用户固定为抽屉当前用户，不再选择 -->
        <el-form-item v-if="!isFixed" label="用户" required>
          <el-select
            v-model="createForm.userId"
            filterable
            remote
            :remote-method="searchCreateUsers"
            :loading="createUserLoading"
            placeholder="搜索用户名 / 昵称"
            style="width: 100%"
          >
            <el-option v-for="u in createUserOptions" :key="u.id" :label="userOptionLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-else label="用户" required>
          <span>{{ fixedUserLabel }}</span>
        </el-form-item>
        <el-form-item label="作用域" required>
          <el-radio-group v-model="createForm.scope">
            <el-radio value="USER">{{ SCOPE_LABELS.USER }}</el-radio>
            <el-radio value="PROJECT">{{ SCOPE_LABELS.PROJECT }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="createForm.scope === 'PROJECT'" label="项目标识" required>
          <el-input v-model="createForm.projectKey" maxlength="128" placeholder="该用户历史会话中出现过的项目标识" />
          <div class="form-hint">服务端仅校验格式；请填写该用户历史会话中出现过的项目标识，手误会导致记忆永不注入</div>
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input
            v-model="createForm.content"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="记忆内容（注入用户后续会话的系统提示词）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'
import type { MemoryScope, MemorySource, MemoryStatus } from '@mao/contracts'
import { useAuthStore } from '../../../stores/auth'
import ResponsivePagination from '../../../components/ResponsivePagination.vue'

const props = defineProps<{
  /** 定人模式（用户详情抽屉）：固定只看/只管理该用户的记忆，隐藏用户筛选与跨用户门控。 */
  fixedUserId?: number | null
  /** 定人模式下代建弹窗展示的用户名（抽屉传入 displayName/username；缺省回退 #id）。 */
  fixedUserLabel?: string | null
}>()

interface MemoryManageItem {
  id: number
  userId: number
  username?: string | null
  displayName?: string | null
  scope: MemoryScope
  projectKey: string | null
  content: string
  source: MemorySource
  status: MemoryStatus
  originSessionId: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface UserOption {
  id: number
  username: string
  displayName?: string | null
}

const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('memory:write'))

const isFixed = computed(() => props.fixedUserId != null)
/** 定人模式下代建弹窗的用户展示名：优先抽屉传入的 displayName/username，缺省回退 #id */
const fixedUserLabel = computed(() => {
  if (!isFixed.value) return '-'
  const name = props.fixedUserLabel?.trim()
  return name ? `${name} (#${props.fixedUserId})` : `#${props.fixedUserId}`
})

const SCOPE_LABELS: Record<MemoryScope, string> = {
  USER: '用户',
  PROJECT: '项目'
}

const SOURCE_LABELS: Record<MemorySource, string> = {
  AUTO: '自动',
  MANUAL: '手动'
}

const STATUS_LABELS: Record<MemoryStatus, string> = {
  ACTIVE: '生效中',
  DISMISSED: '已忽略'
}

function scopeLabel(scope: MemoryScope): string {
  return SCOPE_LABELS[scope] ?? scope
}

function sourceLabel(source: MemorySource): string {
  return SOURCE_LABELS[source] ?? source
}

function statusLabel(status: MemoryStatus): string {
  return STATUS_LABELS[status] ?? status
}

// ── 筛选区 ──
const selectedUserId = ref<number | null>(null)
const keywordFilter = ref('')
const scopeFilter = ref<MemoryScope | ''>('')
const statusFilter = ref<MemoryStatus | ''>('')
const sourceFilter = ref<MemorySource | ''>('')
const projectKeyFilter = ref('')
const dateRange = ref<[string, string] | null>(null)

const loading = ref(false)
const items = ref<MemoryManageItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const submitting = ref(false)

/** D5 合格过滤：跨用户查询必须至少其一非空（时间范围不计入，服务端同口径）。
 * 注意 el-select clearable 清空发出的是 undefined 而非 ''，一律按 truthiness 判断。
 * 定人模式传 userId 即合格过滤，恒可查询。 */
const hasQualifyingFilter = computed(() =>
  keywordFilter.value.trim() !== ''
  || !!scopeFilter.value
  || !!statusFilter.value
  || !!sourceFilter.value
  || projectKeyFilter.value.trim() !== ''
)

const canQuery = computed(() => isFixed.value || selectedUserId.value != null || hasQualifyingFilter.value)

function userOptionLabel(u: UserOption): string {
  return `${u.displayName || u.username} (#${u.id})`
}

function userDisplayName(item: MemoryManageItem): string {
  return item.displayName || item.username || `#${item.userId}`
}

function formatDateTime(value?: string | null) {
  if (!value) return '-'
  return String(value).replace('T', ' ').slice(0, 19)
}

function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {
    page: page.value,
    pageSize: pageSize.value
  }
  if (selectedUserId.value != null) params.userId = selectedUserId.value
  if (keywordFilter.value.trim() !== '') params.keyword = keywordFilter.value.trim()
  if (scopeFilter.value) params.scope = scopeFilter.value
  if (statusFilter.value) params.status = statusFilter.value
  if (sourceFilter.value) params.source = sourceFilter.value
  if (projectKeyFilter.value.trim() !== '') params.projectKey = projectKeyFilter.value.trim()
  if (dateRange.value) {
    const [from, to] = dateRange.value
    if (from) params.updatedFrom = from
    if (to) params.updatedTo = to
  }
  return params
}

async function fetchList() {
  if (!canQuery.value) {
    items.value = []
    total.value = 0
    return
  }
  loading.value = true
  try {
    const { data } = await api.get('/admin/memory', { params: buildParams() })
    items.value = (data?.records ?? []) as MemoryManageItem[]
    total.value = data?.total ?? 0
  } finally {
    loading.value = false
  }
}

/** 筛选控件变化即查询；不满足 D5 时静默清空结果（显式提示留给查询按钮） */
function onFilterChange() {
  if (!canQuery.value) {
    items.value = []
    total.value = 0
    return
  }
  page.value = 1
  void fetchList()
}

function handleSearch() {
  if (!canQuery.value) {
    ElMessage.warning('跨用户查询请先选择用户，或至少填写一个过滤条件（关键词/作用域/状态/来源/项目）')
    return
  }
  page.value = 1
  void fetchList()
}

function handleRefresh() {
  if (!canQuery.value) return
  void fetchList()
}

function resetFilters() {
  keywordFilter.value = ''
  scopeFilter.value = ''
  statusFilter.value = ''
  sourceFilter.value = ''
  projectKeyFilter.value = ''
  dateRange.value = null
}

function handleReset() {
  resetFilters()
  if (isFixed.value) {
    // 定人模式：用户固定，重置后直接回到该用户全量列表
    page.value = 1
    void fetchList()
    return
  }
  selectedUserId.value = null
  page.value = 1
  items.value = []
  total.value = 0
}

// ── 用户选择器（D6：GET /admin/memory/users，keyword 空=注册时间倒序前 N 条）；定人模式不使用 ──
const filterUserOptions = ref<UserOption[]>([])
const filterUserLoading = ref(false)
const createUserOptions = ref<UserOption[]>([])
const createUserLoading = ref(false)

async function fetchUserOptions(keyword: string): Promise<UserOption[]> {
  const { data } = await api.get('/admin/memory/users', {
    params: keyword.trim() !== '' ? { keyword: keyword.trim() } : {}
  })
  return (data?.records ?? []) as UserOption[]
}

async function searchFilterUsers(keyword: string) {
  filterUserLoading.value = true
  try {
    filterUserOptions.value = await fetchUserOptions(keyword)
  } finally {
    filterUserLoading.value = false
  }
}

async function searchCreateUsers(keyword: string) {
  createUserLoading.value = true
  try {
    createUserOptions.value = await fetchUserOptions(keyword)
  } finally {
    createUserLoading.value = false
  }
}

// ── 编辑 / 忽略 / 恢复 / 删除 ──
const editDialogVisible = ref(false)
const editTarget = ref<MemoryManageItem | null>(null)
const editForm = ref<{ content: string; status: MemoryStatus }>({ content: '', status: 'ACTIVE' })

function openEditDialog(row: MemoryManageItem) {
  editTarget.value = row
  editForm.value = { content: row.content, status: row.status }
  editDialogVisible.value = true
}

async function submitEdit() {
  if (!editTarget.value) return
  submitting.value = true
  try {
    await api.patch(`/admin/memory/${editTarget.value.id}`, {
      content: editForm.value.content,
      status: editForm.value.status
    })
    ElMessage.success('已保存')
    editDialogVisible.value = false
    page.value = 1
    void fetchList()
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(row: MemoryManageItem, status: MemoryStatus) {
  await api.patch(`/admin/memory/${row.id}`, { status })
  ElMessage.success(status === 'ACTIVE' ? '已恢复' : '已忽略')
  page.value = 1
  void fetchList()
}

async function handleDelete(row: MemoryManageItem) {
  const confirmed = await ElMessageBox.confirm(
    `将物理删除用户 ${userDisplayName(row)} 的记忆「${row.content.slice(0, 40)}${row.content.length > 40 ? '…' : ''}」，不可恢复，且影响该用户后续所有会话的注入。`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).then(() => true).catch(() => false)
  if (!confirmed) return
  await api.delete(`/admin/memory/${row.id}`)
  ElMessage.success('已删除')
  page.value = 1
  void fetchList()
}

// ── 代建 ──
const createDialogVisible = ref(false)
const createForm = ref<{ userId: number | null; scope: MemoryScope; projectKey: string; content: string }>({
  userId: null,
  scope: 'USER',
  projectKey: '',
  content: ''
})

function openCreateDialog() {
  createForm.value = {
    userId: isFixed.value ? (props.fixedUserId as number) : null,
    scope: 'USER',
    projectKey: '',
    content: ''
  }
  createUserOptions.value = []
  if (!isFixed.value) void searchCreateUsers('')
  createDialogVisible.value = true
}

async function submitCreate() {
  if (createForm.value.userId == null) {
    ElMessage.warning('请选择目标用户')
    return
  }
  if (createForm.value.content.trim() === '') {
    ElMessage.warning('请填写记忆内容')
    return
  }
  if (createForm.value.scope === 'PROJECT' && createForm.value.projectKey.trim() === '') {
    ElMessage.warning('项目级记忆必须填写项目标识')
    return
  }
  submitting.value = true
  try {
    await api.post('/admin/memory', {
      userId: createForm.value.userId,
      scope: createForm.value.scope,
      projectKey: createForm.value.scope === 'PROJECT' ? createForm.value.projectKey.trim() : null,
      content: createForm.value.content
    })
    ElMessage.success('已新增')
    createDialogVisible.value = false
    page.value = 1
    void fetchList()
  } finally {
    submitting.value = false
  }
}

// 定人模式：挂载即拉取该用户全量列表；fixedUserId 变化（抽屉复用实例切用户）时重置重查
watch(() => props.fixedUserId, () => {
  if (props.fixedUserId == null) return
  resetFilters()
  selectedUserId.value = props.fixedUserId
  page.value = 1
  void fetchList()
})

onMounted(() => {
  if (props.fixedUserId != null) {
    selectedUserId.value = props.fixedUserId
    void fetchList()
    return
  }
  void searchFilterUsers('')
})
</script>

<style scoped>
.manage-notice {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-form {
  margin-bottom: 4px;
}

.form-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
  margin-top: 4px;
}

.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
