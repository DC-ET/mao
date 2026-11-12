<template>
  <ResponsiveDialog
    :model-value="modelValue"
    :title="`管理成员${role ? ` - ${role.name}` : ''}`"
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="member-summary">
      <span>当前成员 <strong>{{ memberCount }}</strong> 人</span>
      <span class="member-tip">默认只显示当前成员；切到「全部用户」后可搜索并添加其他人</span>
    </div>

    <div class="member-toolbar">
      <el-radio-group v-model="listMode" size="small" @change="handleListModeChange">
        <el-radio-button value="members">当前成员</el-radio-button>
        <el-radio-button value="all">全部用户</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        placeholder="用户名 / 显示名 / 邮箱"
        clearable
        style="width: 240px"
        @clear="handleSearch"
        @keyup.enter="handleSearch"
      />
      <el-button type="primary" @click="handleSearch">查询</el-button>
      <el-button @click="handleReset">重置</el-button>
    </div>

    <el-table v-loading="loading" :data="users" stripe @selection-change="handleSelectionChange">
      <template #empty>
        <el-empty :description="emptyDescription" :image-size="60" />
      </template>
      <el-table-column type="selection" width="46" />
      <el-table-column prop="username" label="用户名" width="140" show-overflow-tooltip />
      <el-table-column v-if="!isMobile" prop="displayName" label="显示名称" width="120" show-overflow-tooltip />
      <el-table-column v-if="!isMobile" prop="email" label="邮箱" min-width="160" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">
            {{ statusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="成员状态" width="100">
        <template #default="{ row }">
          <el-tag v-if="isMember(row)" type="success" size="small">已加入</el-tag>
          <span v-else class="text-muted">-</span>
        </template>
      </el-table-column>
    </el-table>

    <ResponsivePagination
      class="member-pagination"
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :total="total"
      :page-sizes="[10, 20, 50]"
      @current-change="fetchUsers"
      @size-change="handleSizeChange"
    />

    <template #footer>
      <div class="dialog-footer">
        <span class="selection-hint">
          已选 {{ selectedNonMembers.length }} 人可添加 / {{ selectedMembers.length }} 人可移出
        </span>
        <div class="footer-actions">
          <el-button @click="emit('update:modelValue', false)">取消</el-button>
          <el-button
            type="primary"
            :disabled="selectedNonMembers.length === 0"
            :loading="submitting"
            @click="handleAdd"
          >
            添加为成员{{ selectedNonMembers.length ? `（${selectedNonMembers.length}）` : '' }}
          </el-button>
          <el-button
            type="danger"
            :disabled="selectedMembers.length === 0"
            :loading="submitting"
            @click="handleRemove"
          >
            移出角色{{ selectedMembers.length ? `（${selectedMembers.length}）` : '' }}
          </el-button>
        </div>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import { isRoleMember, roleMemberListParams, type RoleMemberListMode } from './roleMemberQuery'

interface RoleTarget {
  id: number
  name: string
  userCount?: number
}

const props = defineProps<{
  modelValue: boolean
  role: RoleTarget | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  /** 增删成员成功后触发，父组件重拉角色列表刷新用户数 */
  (e: 'changed'): void
}>()

const { isMobile } = useBreakpoint()
const loading = ref(false)
const submitting = ref(false)
const users = ref<any[]>([])
const selectedRows = ref<any[]>([])
const keyword = ref('')
const listMode = ref<RoleMemberListMode>('members')
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const memberCount = computed(() => props.role?.userCount ?? 0)
const emptyDescription = computed(() => {
  const searching = keyword.value.trim().length > 0
  if (listMode.value === 'members') {
    return searching ? '当前成员中没有匹配的用户' : '该角色暂无成员'
  }
  return searching ? '没有匹配的用户' : '暂无数据'
})
const selectedMembers = computed(() => selectedRows.value.filter((row) => isMember(row)))
const selectedNonMembers = computed(() => selectedRows.value.filter((row) => !isMember(row)))

/** 用户状态三态：1=启用 0=禁用 null=未设置（与 UserListView 同口径）。 */
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

/** GET /v1/users 的 records 已带 roleIds，无需另查成员列表即可判定加入状态。 */
function isMember(row: { roleIds?: unknown }): boolean {
  return isRoleMember(props.role?.id, row.roleIds)
}

let fetchSeq = 0
async function fetchUsers() {
  if (!props.role) return
  const seq = ++fetchSeq
  loading.value = true
  try {
    const params = roleMemberListParams({
      page: currentPage.value,
      size: pageSize.value,
      keyword: keyword.value,
      mode: listMode.value,
      roleId: props.role.id,
    })
    const { data } = await api.get('/users', { params })
    if (seq !== fetchSeq) return
    users.value = data?.records || []
    total.value = data?.total || 0
    selectedRows.value = []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchUsers()
}

function handleListModeChange() {
  currentPage.value = 1
  selectedRows.value = []
  fetchUsers()
}

function handleReset() {
  keyword.value = ''
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchUsers()
}

function handleSelectionChange(rows: any[]) {
  selectedRows.value = rows
}

async function handleAdd() {
  if (submitting.value || !props.role || selectedNonMembers.value.length === 0) return
  submitting.value = true
  try {
    const { data } = await api.post(`/roles/${props.role.id}/users`, {
      userIds: selectedNonMembers.value.map((u) => u.id)
    })
    ElMessage.success(`已添加 ${data?.added ?? 0} 人`)
    selectedRows.value = []
    await fetchUsers()
    emit('changed')
  } catch { /* 拦截器已提示失败 */ } finally {
    submitting.value = false
  }
}

async function handleRemove() {
  if (submitting.value || !props.role || selectedMembers.value.length === 0) return
  const count = selectedMembers.value.length
  const names = selectedMembers.value.map((u) => u.username).join('、')
  try {
    await ElMessageBox.confirm(
      `确定将 ${count} 人移出角色「${props.role.name}」吗？\n${names}`,
      '移出成员',
      { type: 'warning', confirmButtonText: '移出', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    const { data } = await api.delete(`/roles/${props.role.id}/users`, {
      data: { userIds: selectedMembers.value.map((u) => u.id) }
    })
    ElMessage.success(`已移除 ${data?.removed ?? 0} 人`)
    selectedRows.value = []
    await fetchUsers()
    emit('changed')
  } catch { /* 拦截器已提示失败 */ } finally {
    submitting.value = false
  }
}

// 打开弹窗（或切换目标角色）时重置分页与搜索，重拉用户列表
watch(
  () => [props.modelValue, props.role?.id] as const,
  ([visible]) => {
    if (!visible) return
    listMode.value = 'members'
    currentPage.value = 1
    keyword.value = ''
    selectedRows.value = []
    fetchUsers()
  }
)
</script>

<style scoped>
.member-summary {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.member-tip {
  color: var(--mao-muted, #909399);
  font-size: 12px;
}

.member-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.member-pagination {
  margin-top: 12px;
  justify-content: flex-end;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.selection-hint {
  color: var(--mao-muted, #909399);
  font-size: 12px;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.text-muted {
  color: var(--mao-muted, #909399);
}
</style>
