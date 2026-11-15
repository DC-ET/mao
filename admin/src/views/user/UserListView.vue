<template>
  <div class="user-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>用户管理</span>
          <div v-if="canWrite" class="card-header-actions">
            <el-button
              type="success"
              :disabled="selectedUsers.length === 0 || batchLoading"
              @click="handleBatchSetStatus(1)"
            >
              批量启用
            </el-button>
            <el-button
              type="danger"
              :disabled="selectedUsers.length === 0 || batchLoading"
              @click="handleBatchSetStatus(0)"
            >
              批量禁用
            </el-button>
            <el-button type="primary" @click="handleCreate">
              <el-icon><Plus /></el-icon>
              新建用户
            </el-button>
          </div>
          <el-button v-else type="primary" disabled>新建用户</el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="filters.keyword"
                placeholder="用户名 / 显示名 / 邮箱"
                clearable
                style="width: 220px"
                @clear="handleSearch"
                @keyup.enter="handleSearch"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="角色">
            <el-select
              v-model="filters.roleId"
              placeholder="全部"
              clearable
              filterable
              style="width: 160px"
              @change="handleRoleChange"
            >
              <el-option
                v-for="role in rolesCache"
                :key="role.id"
                :label="role.name"
                :value="role.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="账号类型">
            <el-select
              v-model="filters.authSource"
              placeholder="全部"
              clearable
              style="width: 130px"
              @change="handleSearch"
            >
              <el-option label="本地" value="LOCAL" />
              <el-option label="LDAP" value="LDAP" />
              <el-option label="飞书" value="FEISHU" />
              <el-option label="ECP" value="ECP" />
              <el-option label="公司 SSO" value="COMPANY_SSO" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px" @change="handleSearch">
              <el-option label="启用" :value="1" />
              <el-option label="禁用" :value="0" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="users" v-loading="loading" stripe @selection-change="handleSelectionChange">
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column type="selection" width="46" :selectable="isRowSelectable" />
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="用户名" width="140" class-name="user-name-col">
          <template #default="{ row }">
            <div class="user-identity">
              <el-avatar :size="28" :src="resolveAvatarUrl(row.avatarUrl)">
                {{ (row.displayName || row.username)?.slice(0, 1) || 'U' }}
              </el-avatar>
              <span class="user-name" :title="row.username">{{ row.username }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="displayName" label="显示名称" width="120" />
        <el-table-column prop="email" label="邮箱" min-width="180" show-overflow-tooltip />
        <el-table-column label="角色" min-width="140">
          <template #default="{ row }">
            <el-tag
              v-for="name in row.roleNames || []"
              :key="name"
              size="small"
              class="role-tag"
            >
              {{ name }}
            </el-tag>
            <span v-if="!row.roleNames?.length" class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="账号类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.authSource === 'LOCAL' ? 'primary' : 'info'" size="small">
              {{ authSourceLabel(row.authSource) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastLoginAt" label="最后登录" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="createdAt" label="创建时间" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleDetail(row)">详情</el-button>
            <template v-if="canWrite">
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button
                type="primary"
                link
                size="small"
                @click="handleResetPassword(row)"
              >
                重置密码
              </el-button>
              <el-button
                :type="row.status === 1 ? 'danger' : 'success'"
                link
                size="small"
                :disabled="isCurrentUser(row) && row.status === 1"
                @click="handleToggleStatus(row)"
              >
                {{ row.status === 1 ? '禁用' : '启用' }}
              </el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile card list -->
      <div v-else class="mobile-card-list">
        <el-card v-for="row in users" :key="row.id" class="user-card" shadow="hover">
          <div class="user-card-head">
            <div class="user-identity">
              <el-avatar :size="28" :src="resolveAvatarUrl(row.avatarUrl)">
                {{ (row.displayName || row.username)?.slice(0, 1) || 'U' }}
              </el-avatar>
              <span class="user-card-name">{{ row.displayName || row.username }}</span>
            </div>
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusLabel(row.status) }}
            </el-tag>
          </div>
          <div class="user-card-row">
            <span class="user-card-label">用户名</span>
            <span>{{ row.username }}</span>
          </div>
          <div class="user-card-row">
            <span class="user-card-label">邮箱</span>
            <span>{{ row.email || '-' }}</span>
          </div>
          <div class="user-card-row">
            <span class="user-card-label">角色</span>
            <span>
              <el-tag
                v-for="name in row.roleNames || []"
                :key="name"
                size="small"
                class="role-tag"
              >
                {{ name }}
              </el-tag>
              <span v-if="!row.roleNames?.length" class="text-muted">-</span>
            </span>
          </div>
          <div class="user-card-row">
            <span class="user-card-label">类型</span>
            <el-tag :type="row.authSource === 'LOCAL' ? 'primary' : 'info'" size="small">
              {{ authSourceLabel(row.authSource) }}
            </el-tag>
          </div>
          <div class="user-card-actions">
            <el-button type="primary" link size="small" @click="handleDetail(row)">详情</el-button>
            <template v-if="canWrite">
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button
                type="primary"
                link
                size="small"
                @click="handleResetPassword(row)"
              >
                重置密码
              </el-button>
              <el-button
                :type="row.status === 1 ? 'danger' : 'success'"
                link
                size="small"
                :disabled="isCurrentUser(row) && row.status === 1"
                @click="handleToggleStatus(row)"
              >
                {{ row.status === 1 ? '禁用' : '启用' }}
              </el-button>
            </template>
          </div>
        </el-card>
        <el-empty v-if="!loading && users.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        @current-change="fetchUsers"
        @size-change="handleSizeChange"
      />
    </el-card>

    <UserFormDialog
      v-if="formDialogVisible"
      :visible="true"
      :user-data="currentUser"
      :mode="formMode"
      @update:visible="formDialogVisible = $event"
      @saved="fetchUsers"
    />

    <ResetPasswordDialog
      v-if="resetDialogVisible"
      :visible="true"
      :user-id="resetUserId"
      :username="resetUsername"
      :auth-source="resetAuthSource"
      @update:visible="resetDialogVisible = $event"
      @saved="fetchUsers"
    />

    <UserDetailDrawer
      :visible="detailVisible"
      :user="detailUser"
      :initial-tab="detailInitialTab"
      @update:visible="detailVisible = $event"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onActivated, onMounted, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { resolveAvatarUrl } from '../../utils/avatar'
import { formatDateTimeColumn } from '../../utils/datetime'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import UserFormDialog from './UserFormDialog.vue'
import ResetPasswordDialog from './ResetPasswordDialog.vue'
import UserDetailDrawer from './UserDetailDrawer.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'

const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const loading = ref(false)
const users = ref<any[]>([])
const selectedUsers = ref<any[]>([])
const batchLoading = ref(false)
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const filters = reactive({
  keyword: '',
  status: undefined as number | undefined,
  authSource: undefined as string | undefined,
  roleId: null as number | null
})

/** 与后端 UserService.resolveAuthSource 的取值一一对应。 */
const AUTH_SOURCE_LABELS: Record<string, string> = {
  LOCAL: '本地',
  LDAP: 'LDAP',
  FEISHU: '飞书',
  ECP: 'ECP',
  COMPANY_SSO: '公司 SSO'
}

function authSourceLabel(source?: string | null) {
  return (source && AUTH_SOURCE_LABELS[source]) || source || '-'
}

/** 用户状态三态：1=启用 0=禁用 null=未设置（与后端 validateUserStatus 注释一致）。 */
function statusLabel(status?: number | null) {
  if (status === 1) return '启用'
  if (status === 0) return '禁用'
  return '未设置'
}

function statusTagType(status?: number | null): 'success' | 'danger' | 'info' {
  if (status === 1) return 'success'
  if (status === 0) return 'danger'
  return 'info'
}

const formDialogVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const currentUser = ref<any | null>(null)
const loadingDetail = ref(false)
const canWrite = computed(() => authStore.hasPermission('user:write'))

const resetDialogVisible = ref(false)
const resetUserId = ref<number | null>(null)
const resetUsername = ref('')
const resetAuthSource = ref<string | null>(null)

const detailVisible = ref(false)
const detailUser = ref<any | null>(null)
/** 深链定位 Tab（如用量分析页「用量详情」→ /users?detail=&tab=usage）；列表「详情」按钮恒 undefined。 */
const detailInitialTab = ref<string | undefined>(undefined)

const rolesCache = ref<Array<{ id: number; name: string }>>([])
/** 已经按地址栏应用过的 roleId。keep-alive 的 key 不含 query，切回时用它判断要不要重拉。 */
let appliedRoleKey = ''

function isCurrentUser(row: any) {
  return row.id === authStore.user?.id
}

/** 行级批量选择限制：当前登录用户不可被禁用 */
function isRowSelectable(row: any) {
  return !(isCurrentUser(row) && row.status === 1)
}

async function fetchRolesOptions() {
  try {
    const { data } = await api.get('/roles')
    rolesCache.value = data || []
  } catch { /* 拦截器已提示失败 */ }
}

let fetchUsersSeq = 0
async function fetchUsers() {
  const seq = ++fetchUsersSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (filters.keyword) params.keyword = filters.keyword
    if (filters.status !== undefined && filters.status !== null) {
      params.status = filters.status
    }
    if (filters.authSource) params.authSource = filters.authSource
    if (filters.roleId != null) params.roleId = filters.roleId

    const { data } = await api.get('/users', { params })
    if (seq !== fetchUsersSeq) return
    users.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchUsersSeq) loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchUsers()
}

function queryWithoutRole(): LocationQuery {
  const query: LocationQuery = { ...route.query }
  delete query.roleId
  return query
}

function handleRoleChange() {
  if (filters.roleId == null || filters.roleId <= 0) filters.roleId = null
  const key = filters.roleId != null ? String(filters.roleId) : ''
  appliedRoleKey = key
  const query = queryWithoutRole()
  if (key) query.roleId = key
  router.replace({ path: '/users', query })
  currentPage.value = 1
  fetchUsers()
}

function handleReset() {
  filters.keyword = ''
  filters.status = undefined
  filters.authSource = undefined
  filters.roleId = null
  appliedRoleKey = ''
  if (route.query.roleId) {
    router.replace({ path: '/users' })
  }
  currentPage.value = 1
  fetchUsers()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchUsers()
}

function handleSelectionChange(rows: any[]) {
  selectedUsers.value = rows
}

/** 简单 Promise 池：并发上限 batchSize，保持提交顺序 */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function handleBatchSetStatus(targetStatus: number) {
  if (batchLoading.value || selectedUsers.value.length === 0) return
  const action = targetStatus === 1 ? '启用' : '禁用'
  // 过滤掉当前登录用户与已是目标状态的行
  const targets = selectedUsers.value.filter(
    (u) => !(isCurrentUser(u) && targetStatus === 0) && u.status !== targetStatus
  )
  if (targets.length === 0) {
    ElMessage.info('所选用户均已处于目标状态（当前登录用户不可禁用）')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定要批量${action} ${targets.length} 个用户吗？`,
      `批量${action}`,
      { confirmButtonText: `确认${action}`, cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  batchLoading.value = true
  let success = 0
  let failed = 0
  try {
    await runWithConcurrency(targets, 3, async (u) => {
      try {
        await api.put(`/users/${u.id}/status`, { status: targetStatus })
        success++
      } catch {
        failed++
      }
    })
    if (failed === 0) {
      ElMessage.success(`批量${action}完成：成功 ${success} 个`)
    } else {
      ElMessage.warning(`批量${action}完成：成功 ${success} 个，失败 ${failed} 个`)
    }
    selectedUsers.value = []
    fetchUsers()
  } finally {
    batchLoading.value = false
  }
}

function handleCreate() {
  formMode.value = 'create'
  currentUser.value = null
  formDialogVisible.value = true
}

async function handleEdit(row: any) {
  if (loadingDetail.value) return
  loadingDetail.value = true
  try {
    const { data } = await api.get(`/users/${row.id}`)
    formMode.value = 'edit'
    currentUser.value = data
    formDialogVisible.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingDetail.value = false
  }
}

function handleResetPassword(row: any) {
  resetUserId.value = row.id
  resetUsername.value = row.username
  resetAuthSource.value = row.authSource ?? null
  resetDialogVisible.value = true
}

function handleDetail(row: any) {
  detailUser.value = row
  detailInitialTab.value = undefined
  detailVisible.value = true
}

/**
 * 跨页反链进用户详情：解析 ?detail={userId}&tab={usage|memory}（白名单见下方三元），
 * 取用户后打开抽屉并定位 Tab。地址栏参数取后即清（保留 roleId 等），keep-alive
 * 回切不会重复打开；appliedDetailKey 防同参数重复拉取。
 */
let appliedDetailKey = ''
async function syncDetailFromRoute(): Promise<void> {
  const q = route.query
  const raw = Array.isArray(q.detail) ? q.detail[0] : q.detail
  const tabRaw = Array.isArray(q.tab) ? q.tab[0] : q.tab
  if (raw == null || raw === '') return
  const rest: LocationQuery = { ...q }
  delete rest.detail
  delete rest.tab
  router.replace({ path: '/users', query: rest })
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return
  const tab = tabRaw === 'usage' || tabRaw === 'memory' ? tabRaw : undefined
  const key = `${parsed}|${tab ?? ''}`
  if (key === appliedDetailKey) return
  appliedDetailKey = key
  try {
    const { data } = await api.get(`/users/${parsed}`)
    if (!data) return
    detailUser.value = data
    detailInitialTab.value = tab
    detailVisible.value = true
  } catch {
    // 失败回收防重键：URL 已被清掉，同参数深链必须还能重试，不能被死锁键吞掉
    appliedDetailKey = ''
  }
}

async function handleToggleStatus(row: any) {
  const action = row.status === 1 ? '禁用' : '启用'
  try {
    await ElMessageBox.confirm(`确定要${action}用户 "${row.displayName}" 吗？`, '确认')
    await api.put(`/users/${row.id}/status`, { status: row.status === 1 ? 0 : 1 })
    ElMessage.success(`${action}成功`)
    fetchUsers()
  } catch {
    // Cancelled or error handled by interceptor
  }
}

/** 把地址栏 roleId 写进筛选。非法值清掉参数。返回是否相对上次应用有变化。 */
function syncRoleFromRoute(): boolean {
  const raw = Array.isArray(route.query.roleId) ? route.query.roleId[0] : route.query.roleId
  if (raw != null && raw !== '') {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      filters.roleId = null
      appliedRoleKey = ''
      router.replace({ path: '/users', query: queryWithoutRole() })
      return true
    }
    const key = String(parsed)
    if (key === appliedRoleKey && filters.roleId === parsed) return false
    appliedRoleKey = key
    filters.roleId = parsed
    return true
  }
  if (appliedRoleKey === '' && filters.roleId == null) return false
  appliedRoleKey = ''
  filters.roleId = null
  return true
}

function applyRoleRouteChange() {
  if (route.name !== 'Users') return
  if (!syncRoleFromRoute()) return
  currentPage.value = 1
  fetchUsers()
}

onMounted(async () => {
  await fetchRolesOptions()
  syncRoleFromRoute()
  if (!authStore.user) {
    await authStore.fetchUserInfo()
  }
  fetchUsers()
  void syncDetailFromRoute()
})

// 同页 query 变化（侧边栏回到 /users、角色页「成员」、用量分析页「用量详情」）不会重建 keep-alive 实例。
watch(() => route.fullPath, () => {
  applyRoleRouteChange()
  void syncDetailFromRoute()
})

// keep-alive 首次挂载 onActivated 紧随 onMounted，跳过以免重复请求。
let activatedOnce = false
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  applyRoleRouteChange()
})
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

.card-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.role-tag {
  margin-right: 4px;
}

.user-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.user-identity .el-avatar {
  flex-shrink: 0;
}

.user-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

:deep(.user-name-col .cell) {
  overflow-wrap: normal;
  word-break: keep-all;
}

.text-muted {
  color: var(--mao-muted);
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-card {
  font-size: 14px;
}

.user-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.user-card-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-card-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.5;
}

.user-card-label {
  width: 48px;
  flex-shrink: 0;
  color: var(--mao-muted);
}

.user-card-actions {
  display: flex;
  gap: 4px;
  margin-top: 10px;
  border-top: 1px solid var(--mao-border);
  padding-top: 10px;
}
</style>
