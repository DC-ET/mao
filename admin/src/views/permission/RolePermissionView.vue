<template>
  <div class="role-permission">
    <el-row :gutter="16">
      <el-col :span="10">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>角色列表</span>
              <el-button v-if="canWrite" type="primary" @click="handleCreateRole">
                <el-icon><Plus /></el-icon>
                新建角色
              </el-button>
            </div>
          </template>

          <el-table :data="roles" v-loading="loading" stripe highlight-current-row @row-click="handleRoleRowClick">
            <el-table-column prop="name" label="角色" min-width="120" />
            <el-table-column prop="code" label="编码" width="110" />
            <el-table-column prop="userCount" label="用户数" width="80" align="right" />
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link size="small" @click.stop="handleViewMembers(row)">成员</el-button>
                <el-button v-if="canWrite" type="primary" link size="small" @click.stop="handleEditRole(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>权限分配</span>
              <el-button
                :type="dirtyPermissions ? 'primary' : 'default'"
                :disabled="!currentRole || !canWrite"
                :loading="savingPermissions"
                @click="savePermissions"
              >
                保存权限{{ dirtyPermissions ? '*' : '' }}
              </el-button>
            </div>
          </template>

          <el-empty v-if="!currentRole" description="请选择左侧角色" />
          <div v-else>
            <div class="role-title">
              <strong>{{ currentRole.name }}</strong>
              <el-tag size="small">{{ currentRole.code }}</el-tag>
            </div>
            <el-collapse v-model="expandedGroups" class="permission-groups">
              <el-collapse-item v-for="group in permissionGroups" :key="group.id" :name="group.id">
                <template #title>
                  <div class="group-title" @click.stop>
                    <el-checkbox
                      :model-value="isGroupAllSelected(group)"
                      :indeterminate="isGroupIndeterminate(group)"
                      :disabled="savingPermissions || !canWrite"
                      @change="toggleGroup(group, $event as boolean)"
                    >
                      {{ group.label }}
                    </el-checkbox>
                    <span class="group-count">{{ group.items.length }}</span>
                  </div>
                </template>
                <el-checkbox-group
                  :model-value="selectedPermissionIds"
                  class="permission-grid"
                  :disabled="savingPermissions || !canWrite"
                  @update:model-value="onPermissionChange($event as number[])"
                >
                  <el-checkbox
                    v-for="permission in group.items"
                    :key="permission.id"
                    :value="permission.id"
                    border
                  >
                    <span>{{ permission.name }}</span>
                    <small>{{ permission.code }}</small>
                  </el-checkbox>
                </el-checkbox-group>
              </el-collapse-item>
            </el-collapse>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <ResponsiveDialog v-if="dialogVisible" v-model="dialogVisible" :title="dialogMode === 'create' ? '新建角色' : '编辑角色'" width="480px">
      <el-form ref="roleFormRef" :model="roleForm" :rules="roleFormRules" label-width="90px">
        <el-form-item label="角色名称" prop="name">
          <el-input v-model="roleForm.name" placeholder="例如：运营管理员" />
        </el-form-item>
        <el-form-item label="角色编码" prop="code">
          <el-input v-model="roleForm.code" :disabled="dialogMode === 'edit'" placeholder="例如：OPS_ADMIN（2-32 位大写字母/数字/下划线）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleForm.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingRole" @click="saveRole">保存</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface Role {
  id: number
  name: string
  code: string
  description?: string
  permissionIds?: number[]
  userCount?: number
}

interface Permission {
  id: number
  name: string
  code: string
  description?: string
}

const loading = ref(false)
const savingRole = ref(false)
const savingPermissions = ref(false)
const roles = ref<Role[]>([])
const permissions = ref<Permission[]>([])
const currentRole = ref<Role | null>(null)
const dirtyPermissions = ref(false)
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const roleFormRef = ref<FormInstance>()
const router = useRouter()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('role:write'))
const roleForm = reactive({
  id: 0,
  name: '',
  code: '',
  description: ''
})

// 后端 createRole 对编码无格式约束，前端按建议 pattern 统一约束（评审 #28）
const roleCodePattern = /^[A-Z0-9_]{2,32}$/

const roleFormRules: FormRules = {
  name: [{ required: true, message: '请输入角色名称', trigger: 'blur' }],
  code: [
    { required: true, message: '请输入角色编码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (!roleCodePattern.test(value || '')) {
          callback(new Error('编码须为 2-32 位大写字母、数字或下划线'))
          return
        }
        callback()
      },
      trigger: 'blur'
    }
  ]
}

/** 与权限清单一致的分组。未知前缀单独成组，避免新码加进来后页面空白。 */
interface PermissionGroup {
  id: string
  label: string
  items: Permission[]
}

const PERMISSION_SECTIONS: { id: string; label: string; prefixes: string[] }[] = [
  { id: 'capability', label: '能力', prefixes: ['agent', 'model', 'skill', 'feishu-bot', 'dingtalk-bot', 'command', 'mcp'] },
  { id: 'runtime', label: '运行', prefixes: ['session', 'scheduled-task', 'llm-call', 'analytics'] },
  { id: 'security', label: '安全', prefixes: ['user', 'role', 'audit'] },
  { id: 'system', label: '系统', prefixes: ['settings'] },
  { id: 'terminal', label: '云端终端', prefixes: ['terminal'] }
]

function permissionOrder(code: string, prefixes: string[]): number {
  const prefix = code.split(':')[0] || 'other'
  const index = prefixes.indexOf(prefix)
  const action = code.endsWith(':read') ? 0 : code.endsWith(':write') ? 1 : 2
  return (index < 0 ? prefixes.length : index) * 10 + action
}

const permissionGroups = computed<PermissionGroup[]>(() => {
  const byPrefix = new Map<string, Permission[]>()
  for (const perm of permissions.value) {
    const prefix = perm.code.split(':')[0] || 'other'
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
    byPrefix.get(prefix)!.push(perm)
  }
  const used = new Set<string>()
  const groups: PermissionGroup[] = []
  for (const section of PERMISSION_SECTIONS) {
    const items = section.prefixes.flatMap((prefix) => byPrefix.get(prefix) ?? [])
    if (items.length === 0) continue
    section.prefixes.forEach((prefix) => used.add(prefix))
    items.sort((a, b) => permissionOrder(a.code, section.prefixes) - permissionOrder(b.code, section.prefixes) || a.code.localeCompare(b.code))
    groups.push({ id: section.id, label: section.label, items })
  }
  for (const [prefix, items] of byPrefix) {
    if (used.has(prefix)) continue
    items.sort((a, b) => a.code.localeCompare(b.code))
    groups.push({ id: prefix, label: prefix, items })
  }
  return groups
})

const expandedGroups = ref<string[]>([])
const selectedPermissionIds = ref<number[]>([])

function isGroupAllSelected(group: PermissionGroup): boolean {
  return group.items.every((p) => selectedPermissionIds.value.includes(p.id))
}

function isGroupIndeterminate(group: PermissionGroup): boolean {
  const selected = group.items.filter((p) => selectedPermissionIds.value.includes(p.id)).length
  return selected > 0 && selected < group.items.length
}

function toggleGroup(group: PermissionGroup, checked: boolean) {
  const groupIds = group.items.map((p) => p.id)
  if (checked) {
    selectedPermissionIds.value = Array.from(new Set([...selectedPermissionIds.value, ...groupIds]))
  } else {
    selectedPermissionIds.value = selectedPermissionIds.value.filter((id) => !groupIds.includes(id))
  }
  dirtyPermissions.value = true
}

async function fetchAll() {
  loading.value = true
  try {
    const [roleRes, permissionRes] = await Promise.all([
      api.get('/roles'),
      api.get('/permissions')
    ])
    roles.value = roleRes.data || []
    permissions.value = permissionRes.data || []
    if (expandedGroups.value.length === 0 && permissions.value.length > 0) {
      expandedGroups.value = permissionGroups.value.map((g) => g.id)
    }
    if (!currentRole.value && roles.value.length > 0) {
      selectRole(roles.value[0])
    }
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loading.value = false
  }
}

function selectRole(role: Role) {
  currentRole.value = role
  selectedPermissionIds.value = [...(role.permissionIds || [])]
  dirtyPermissions.value = false
}

/** 勾选变化置脏；row-click 切换角色时如有未保存修改先确认 */
function onPermissionChange(next: number[]) {
  selectedPermissionIds.value = next
  dirtyPermissions.value = true
}

async function confirmDiscardUnsaved(): Promise<boolean> {
  if (!dirtyPermissions.value) return true
  try {
    await ElMessageBox.confirm('当前角色的权限修改尚未保存，切换后将丢失，确认切换吗？', '未保存的修改', {
      confirmButtonText: '放弃修改并切换',
      cancelButtonText: '留在当前角色',
      type: 'warning'
    })
    return true
  } catch {
    return false
  }
}

async function handleRoleRowClick(role: Role) {
  if (savingPermissions.value) return
  if (role.id === currentRole.value?.id) return
  if (!(await confirmDiscardUnsaved())) return
  selectRole(role)
}

function handleCreateRole() {
  dialogMode.value = 'create'
  Object.assign(roleForm, { id: 0, name: '', code: '', description: '' })
  dialogVisible.value = true
}

function handleEditRole(role: Role) {
  dialogMode.value = 'edit'
  Object.assign(roleForm, {
    id: role.id,
    name: role.name,
    code: role.code,
    description: role.description || ''
  })
  dialogVisible.value = true
}

function handleViewMembers(role: Role) {
  // 后端 listUsers 暂不支持 roleId 参数，先传 query 表达筛选意图（评审 #7）
  router.push({ path: '/users', query: { roleId: String(role.id) } })
}

async function saveRole() {
  if (savingRole.value) return
  const valid = await roleFormRef.value?.validate().catch(() => false)
  if (!valid) return
  savingRole.value = true
  try {
    if (dialogMode.value === 'create') {
      await api.post('/roles', roleForm)
      ElMessage.success('角色已创建')
    } else {
      await api.put(`/roles/${roleForm.id}`, roleForm)
      ElMessage.success('角色已更新')
    }
    dialogVisible.value = false
    await fetchAll()
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    savingRole.value = false
  }
}

async function savePermissions() {
  if (!currentRole.value || savingPermissions.value) return
  savingPermissions.value = true
  try {
    await api.put(`/roles/${currentRole.value.id}/permissions`, {
      permissionIds: selectedPermissionIds.value
    })
    ElMessage.success('权限已保存')
    dirtyPermissions.value = false
    // Keep the current role selected and refresh so checkbox state stays in sync
    const id = currentRole.value.id
    await fetchAll()
    const updated = roles.value.find(r => r.id === id)
    if (updated) selectRole(updated)
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    savingPermissions.value = false
  }
}

onMounted(() => {
  fetchAll()
  // 路由离开守卫之外，浏览器刷新/关闭也需要拦截（评审 #29）
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirtyPermissions.value) return
  event.preventDefault()
  // Chrome 需要 returnValue 才会弹出确认
  event.returnValue = ''
}

onBeforeRouteLeave(async (_to, _from) => {
  if (!dirtyPermissions.value) return true
  try {
    await ElMessageBox.confirm('当前角色的权限修改尚未保存，离开后将丢失，确认离开吗？', '未保存的修改', {
      confirmButtonText: '放弃修改并离开',
      cancelButtonText: '留在当前页',
      type: 'warning'
    })
    return true
  } catch {
    return false
  }
})

// TODO: 需后端补 DELETE /roles/:id（校验角色下无用户）后再提供删除角色按钮，
// 见评审文档 #7（permission.routes.ts 目前仅有 create/update/assign 端点）。
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.role-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.permission-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 4px 0;
}

.permission-groups :deep(.el-collapse-item__header) {
  height: auto;
  padding: 6px 0;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.group-count {
  color: var(--mao-muted, #909399);
  font-size: 12px;
}

.permission-grid :deep(.el-checkbox) {
  height: auto;
  margin: 0;
  padding: 10px 12px;
}

.permission-grid small {
  display: block;
  color: #909399;
  margin-top: 2px;
}

@media (max-width: 768px) {
  .role-permission :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .role-permission :deep(.el-col) {
    max-width: 100%;
    flex: 0 0 100%;
    margin-bottom: 16px;
  }

  .permission-grid {
    grid-template-columns: 1fr;
  }
}
</style>
