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

      <el-alert
        v-if="roleFilterName"
        type="warning"
        :closable="true"
        show-icon
        class="role-filter-alert"
      >
        按角色「{{ roleFilterName }}」筛选需要后端支持 roleId 查询参数（当前 listUsers 仅支持 keyword/status），已在评审文档 #6/#7 中记录；本页暂未做角色过滤。
      </el-alert>

      <el-table v-if="!isMobile" :data="displayedUsers" v-loading="loading" stripe @selection-change="handleSelectionChange">
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column type="selection" width="46" :selectable="isRowSelectable" />
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="用户名" width="120" />
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
              {{ row.authSource === 'LOCAL' ? '本地' : 'LDAP' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastLoginAt" label="最后登录" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column prop="createdAt" label="创建时间" width="180" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <template v-if="canWrite">
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-tooltip
                :disabled="row.authSource === 'LOCAL'"
                content="LDAP 用户密码由目录服务管理"
                placement="top"
              >
                <span>
                  <el-button
                    type="primary"
                    link
                    size="small"
                    :disabled="row.authSource !== 'LOCAL'"
                    @click="handleResetPassword(row)"
                  >
                    重置密码
                  </el-button>
                </span>
              </el-tooltip>
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
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile card list -->
      <div v-else class="mobile-card-list">
        <el-card v-for="row in users" :key="row.id" class="user-card" shadow="hover">
          <div class="user-card-head">
            <span class="user-card-name">{{ row.displayName || row.username }}</span>
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
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
              {{ row.authSource === 'LOCAL' ? '本地' : 'LDAP' }}
            </el-tag>
          </div>
          <div class="user-card-actions">
            <template v-if="canWrite">
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button
                type="primary"
                link
                size="small"
                :disabled="row.authSource !== 'LOCAL'"
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
      @update:visible="resetDialogVisible = $event"
      @saved="fetchUsers"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTimeColumn } from '../../utils/datetime'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import UserFormDialog from './UserFormDialog.vue'
import ResetPasswordDialog from './ResetPasswordDialog.vue'
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
  authSource: undefined as string | undefined
})

const formDialogVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const currentUser = ref<any | null>(null)
const loadingDetail = ref(false)
const canWrite = computed(() => authStore.hasPermission('user:write'))

const resetDialogVisible = ref(false)
const resetUserId = ref<number | null>(null)
const resetUsername = ref('')

/** route.query.roleId 仅作为筛选意图提示（后端 listUsers 不支持 roleId，评审文档 #6/#7 已记录） */
const queryRoleId = ref<number | null>(null)
const roleFilterName = ref('')
const rolesCache = ref<Array<{ id: number; name: string }>>([])

function isCurrentUser(row: any) {
  return row.id === authStore.user?.id
}

/** 行级批量选择限制：当前登录用户不可被禁用 */
function isRowSelectable(row: any) {
  return !(isCurrentUser(row) && row.status === 1)
}

/** 账号类型为前端过滤（后端 listUsers 无 authType 参数），仅作用于当前页 */
const displayedUsers = computed(() => {
  if (!filters.authSource) return users.value
  return users.value.filter((u) => (u.authSource || 'LOCAL') === filters.authSource)
})

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

function handleReset() {
  filters.keyword = ''
  filters.status = undefined
  filters.authSource = undefined
  queryRoleId.value = null
  roleFilterName.value = ''
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
  resetDialogVisible.value = true
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

onMounted(async () => {
  // 支持 /users?roleId=x：后端暂不支持按角色过滤，仅解析意图给出提示
  const roleIdRaw = route.query.roleId
  if (roleIdRaw) {
    const parsed = Number(roleIdRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      queryRoleId.value = parsed
      await fetchRolesOptions()
      roleFilterName.value = rolesCache.value.find((r) => r.id === parsed)?.name || `#${parsed}`
    } else {
      router.replace({ path: '/users' })
    }
  }
  if (!authStore.user) {
    await authStore.fetchUserInfo()
  }
  fetchUsers()
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

.role-filter-alert {
  margin-bottom: 16px;
}

.role-tag {
  margin-right: 4px;
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
