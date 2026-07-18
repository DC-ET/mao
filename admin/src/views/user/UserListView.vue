<template>
  <div class="user-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>用户管理</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            新建用户
          </el-button>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
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
        <el-form-item label="状态">
          <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px">
            <el-option label="启用" :value="1" />
            <el-option label="禁用" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="!isMobile" :data="users" v-loading="loading" stripe>
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
        <el-table-column prop="lastLoginAt" label="最后登录" width="170" />
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
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
      v-model:visible="formDialogVisible"
      :user-data="currentUser"
      :mode="formMode"
      @saved="fetchUsers"
    />

    <ResetPasswordDialog
      v-model:visible="resetDialogVisible"
      :user-id="resetUserId"
      :username="resetUsername"
      @saved="fetchUsers"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import UserFormDialog from './UserFormDialog.vue'
import ResetPasswordDialog from './ResetPasswordDialog.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

const authStore = useAuthStore()
const { isMobile } = useBreakpoint()
const loading = ref(false)
const users = ref<any[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const filters = reactive({
  keyword: '',
  status: undefined as number | undefined
})

const formDialogVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const currentUser = ref<any | null>(null)

const resetDialogVisible = ref(false)
const resetUserId = ref<number | null>(null)
const resetUsername = ref('')

function isCurrentUser(row: any) {
  return row.id === authStore.user?.id
}

async function fetchUsers() {
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
    users.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchUsers()
}

function handleReset() {
  filters.keyword = ''
  filters.status = undefined
  currentPage.value = 1
  fetchUsers()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchUsers()
}

function handleCreate() {
  formMode.value = 'create'
  currentUser.value = null
  formDialogVisible.value = true
}

async function handleEdit(row: any) {
  const { data } = await api.get(`/users/${row.id}`)
  formMode.value = 'edit'
  currentUser.value = data
  formDialogVisible.value = true
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

.role-tag {
  margin-right: 4px;
}

.text-muted {
  color: #909399;
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
  color: #303133;
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
  color: #909399;
}

.user-card-actions {
  display: flex;
  gap: 4px;
  margin-top: 10px;
  border-top: 1px solid #f0f0f0;
  padding-top: 10px;
}
</style>
