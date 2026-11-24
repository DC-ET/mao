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
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link size="small" @click.stop="handleViewMembers(row)">成员</el-button>
                <el-button v-if="canWrite" type="primary" link size="small" @click.stop="handleEditRole(row)">编辑</el-button>
                <el-button
                  v-if="canWrite && !isBuiltinRole(row)"
                  type="danger"
                  link
                  size="small"
                  :disabled="deletingRoleId === row.id"
                  :title="(row.userCount ?? 0) > 0 ? '请先移除全部成员' : '删除角色'"
                  @click.stop="handleDeleteRole(row)"
                >删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>{{ currentRole ? `${currentRole.name}（${currentRole.code}）` : '角色配置' }}</span>
              <el-button
                v-if="rightTab === 'permissions'"
                :type="dirtyPermissions ? 'primary' : 'default'"
                :disabled="!currentRole || !canWrite"
                :loading="savingPermissions"
                @click="savePermissions"
              >
                保存权限{{ dirtyPermissions ? '*' : '' }}
              </el-button>
              <el-button
                v-else
                :type="dirtySkills ? 'primary' : 'default'"
                :disabled="!canSaveSkills"
                :loading="savingSkills"
                @click="saveSkills"
              >
                保存技能{{ dirtySkills ? '*' : '' }}
              </el-button>
            </div>
          </template>

          <el-empty v-if="!currentRole" description="请选择左侧角色" />
          <el-tabs v-else v-model="rightTab" :before-leave="beforeRightTabLeave">
            <el-tab-pane label="权限" name="permissions">
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
            </el-tab-pane>
            <el-tab-pane label="技能" name="skills">
              <p class="skill-hint">这里追加的是岗位专属系统技能，会叠在 Agent 表单里的共用技能之上。ADMIN、USER 这类人人都有的角色不要配岗位技能，否则等于全员可见。</p>
              <el-table :data="skillGrants" v-loading="loadingSkills" size="small" empty-text="尚未追加技能">
                <el-table-column prop="skillName" label="技能" min-width="140" />
                <el-table-column label="范围" min-width="160">
                  <template #default="{ row }">{{ agentLabel(row.agentId) }}</template>
                </el-table-column>
                <el-table-column label="" width="70">
                  <template #default="{ $index }">
                    <el-button v-if="canWrite" type="danger" link size="small" @click="removeSkillGrant($index)">移除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <div v-if="canWrite && canSaveSkills" class="skill-add">
                <el-select v-model="draftSkillName" filterable placeholder="选择技能" style="width: 180px">
                  <el-option v-for="skill in skillOptions" :key="skill.name" :label="skill.name" :value="skill.name" />
                </el-select>
                <el-select v-model="draftAgentId" filterable placeholder="范围" style="width: 180px">
                  <el-option :value="0" label="全部 Agent" />
                  <el-option
                    v-for="agent in agentOptions"
                    :key="agent.id"
                    :label="agent.enabled ? agent.name : `${agent.name}（已停用）`"
                    :value="agent.id"
                  />
                </el-select>
                <el-button @click="addSkillGrant">添加</el-button>
              </div>
            </el-tab-pane>
          </el-tabs>
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

    <RoleMemberDialog v-model="memberDialogVisible" :role="memberRole" @changed="handleMembersChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onActivated, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import RoleMemberDialog from './RoleMemberDialog.vue'

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
const savingSkills = ref(false)
const loadingSkills = ref(false)
const roles = ref<Role[]>([])
const permissions = ref<Permission[]>([])
const currentRole = ref<Role | null>(null)
const dirtyPermissions = ref(false)
const dirtySkills = ref(false)
const skillGrantsReady = ref(false)
const skillGrantsRoleId = ref<number | null>(null)
const rightTab = ref<'permissions' | 'skills'>('permissions')
const skillGrants = ref<SkillGrant[]>([])
const skillOptions = ref<{ name: string }[]>([])
const agentOptions = ref<{ id: number; name: string; enabled: boolean }[]>([])
const draftSkillName = ref('')
const draftAgentId = ref(0)
let skillLoadSeq = 0

interface SkillGrant {
  skillName: string
  agentId: number
}
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const deletingRoleId = ref<number | null>(null)
const BUILTIN_ROLE_CODES = new Set(['ADMIN', 'USER'])

function isBuiltinRole(role: Role): boolean {
  return BUILTIN_ROLE_CODES.has(role.code)
}
const memberDialogVisible = ref(false)
const memberRole = ref<Role | null>(null)
const roleFormRef = ref<FormInstance>()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('role:write'))
const canSaveSkills = computed(() =>
  !!currentRole.value
  && canWrite.value
  && skillGrantsReady.value
  && skillGrantsRoleId.value === currentRole.value.id
  && !loadingSkills.value,
)
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

function selectRole(role: Role, opts: { permissions?: boolean; skills?: boolean } = {}) {
  const reloadPermissions = opts.permissions !== false
  const reloadSkills = opts.skills !== false
  currentRole.value = role
  if (reloadPermissions) {
    selectedPermissionIds.value = [...(role.permissionIds || [])]
    dirtyPermissions.value = false
  }
  if (reloadSkills) {
    dirtySkills.value = false
    skillGrants.value = []
    skillGrantsReady.value = false
    skillGrantsRoleId.value = null
    void loadSkillGrants(role.id)
  }
}

function agentLabel(agentId: number): string {
  if (agentId === 0) return '全部 Agent'
  const agent = agentOptions.value.find((item) => item.id === agentId)
  if (!agent) return `Agent #${agentId}`
  return agent.enabled ? agent.name : `${agent.name}（已停用）`
}

function markSkillsDirty() {
  dirtySkills.value = true
}

function addSkillGrant() {
  const skillName = draftSkillName.value.trim()
  if (!skillName) {
    ElMessage.warning('请选择技能')
    return
  }
  const agentId = draftAgentId.value
  if (skillGrants.value.some((grant) => grant.skillName === skillName && grant.agentId === agentId)) {
    ElMessage.warning('这条授权已经在列表里')
    return
  }
  if (skillGrants.value.some((grant) => grant.skillName === skillName && (grant.agentId === 0 || agentId === 0))) {
    ElMessage.warning('同一技能不能同时授权给全部 Agent 和某个 Agent')
    return
  }
  skillGrants.value = [...skillGrants.value, { skillName, agentId }]
  draftSkillName.value = ''
  markSkillsDirty()
}

function removeSkillGrant(index: number) {
  skillGrants.value = skillGrants.value.filter((_, i) => i !== index)
  markSkillsDirty()
}

async function loadSkillGrants(roleId: number) {
  const seq = ++skillLoadSeq
  loadingSkills.value = true
  try {
    const { data } = await api.get(`/roles/${roleId}/skills`)
    if (seq !== skillLoadSeq || currentRole.value?.id !== roleId || dirtySkills.value) return
    skillGrants.value = (Array.isArray(data) ? data : []).map((row: SkillGrant) => ({
      skillName: row.skillName,
      agentId: Number(row.agentId) || 0,
    }))
    skillGrantsRoleId.value = roleId
    skillGrantsReady.value = true
    dirtySkills.value = false
  } catch {
    if (seq === skillLoadSeq && currentRole.value?.id === roleId) {
      skillGrantsReady.value = false
      skillGrantsRoleId.value = null
    }
  } finally {
    if (seq === skillLoadSeq) loadingSkills.value = false
  }
}

async function loadSkillEditorOptions() {
  try {
    const [skills, agents] = await Promise.all([
      api.get('/skill-docs'),
      api.get('/agents', { params: { includeDisabled: true } }),
    ])
    skillOptions.value = (Array.isArray(skills.data) ? skills.data : [])
      .filter((row: { name?: string }) => typeof row?.name === 'string')
      .map((row: { name: string }) => ({ name: row.name }))
    agentOptions.value = (Array.isArray(agents.data) ? agents.data : [])
      .map((row: Record<string, unknown>) => ({
        id: Number(row.id),
        name: typeof row.name === 'string' ? row.name : '',
        enabled: row.enabled !== false,
      }))
      .filter((agent) => Number.isInteger(agent.id) && agent.id > 0 && agent.name !== '')
  } catch {
    skillOptions.value = []
    agentOptions.value = []
  }
}

async function saveSkills() {
  const roleId = currentRole.value?.id
  if (roleId == null || savingSkills.value || !canSaveSkills.value) return
  savingSkills.value = true
  try {
    await api.put(`/roles/${roleId}/skills`, {
      grants: skillGrants.value.map((grant) => ({ skillName: grant.skillName, agentId: grant.agentId })),
    })
    if (currentRole.value?.id !== roleId) return
    ElMessage.success('技能授权已保存')
    dirtySkills.value = false
    skillGrantsRoleId.value = roleId
    skillGrantsReady.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    savingSkills.value = false
  }
}

/**
 * 重拉角色列表后按当前选中角色找回最新对象。
 * 权限有未保存修改时只替换标题对象，不清勾选状态（与保存角色时的旧行为一致）。
 */
async function refreshRoles() {
  await fetchAll()
  const id = currentRole.value?.id
  if (id == null) return
  const updated = roles.value.find((r) => r.id === id)
  if (!updated) return
  selectRole(updated, { permissions: !dirtyPermissions.value, skills: !dirtySkills.value })
}

/** 勾选变化置脏；row-click 切换角色时如有未保存修改先确认 */
function onPermissionChange(next: number[]) {
  selectedPermissionIds.value = next
  dirtyPermissions.value = true
}

function unsavedParts(): string[] {
  const parts: string[] = []
  if (dirtyPermissions.value) parts.push('权限')
  if (dirtySkills.value) parts.push('技能')
  return parts
}

async function confirmDiscard(action: '切换' | '离开'): Promise<boolean> {
  const parts = unsavedParts()
  if (parts.length === 0) return true
  try {
    await ElMessageBox.confirm(`当前角色的${parts.join('和')}修改尚未保存，${action}后将丢失，确认${action}吗？`, '未保存的修改', {
      confirmButtonText: action === '切换' ? '放弃修改并切换' : '放弃修改并离开',
      cancelButtonText: action === '切换' ? '留在当前角色' : '留在当前页',
      type: 'warning'
    })
    return true
  } catch {
    return false
  }
}

async function beforeRightTabLeave(): Promise<boolean> {
  if (savingPermissions.value || savingSkills.value) return false
  return confirmDiscard('切换')
}

async function handleRoleRowClick(role: Role) {
  if (savingPermissions.value || savingSkills.value) return
  if (role.id === currentRole.value?.id) return
  if (!(await confirmDiscard('切换'))) return
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
  memberRole.value = role
  memberDialogVisible.value = true
}

async function handleDeleteRole(role: Role) {
  if (deletingRoleId.value != null || isBuiltinRole(role)) return
  if ((role.userCount ?? 0) > 0) {
    ElMessage.warning(`角色「${role.name}」还有 ${role.userCount} 名成员，请先在「成员」中移出后再删除`)
    return
  }
  const unsaved = role.id === currentRole.value?.id ? unsavedParts() : []
  const extra = unsaved.length > 0 ? `当前未保存的${unsaved.join('和')}修改会一并丢弃。` : ''
  try {
    await ElMessageBox.confirm(
      `确定删除角色「${role.name}」（${role.code}）吗？删除后权限、技能授权和系统指令里指向该角色的可见范围会一并移除，且不可恢复。${extra}`,
      '删除角色',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  deletingRoleId.value = role.id
  try {
    await api.delete(`/roles/${role.id}`)
    ElMessage.success('角色已删除')
    if (memberRole.value?.id === role.id) {
      memberDialogVisible.value = false
      memberRole.value = null
    }
    if (currentRole.value?.id === role.id) {
      currentRole.value = null
      dirtyPermissions.value = false
      dirtySkills.value = false
    }
    await refreshRoles()
  } catch { /* 拦截器已提示失败 */ } finally {
    if (deletingRoleId.value === role.id) deletingRoleId.value = null
  }
}

/** 弹窗内增删成员后：刷新角色列表的用户数，并同步弹窗拿到的角色对象。 */
async function handleMembersChanged() {
  await refreshRoles()
  if (memberRole.value) {
    const updated = roles.value.find((r) => r.id === memberRole.value!.id)
    if (updated) memberRole.value = updated
  }
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
    await refreshRoles()
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
    await refreshRoles()
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    savingPermissions.value = false
  }
}

onMounted(() => {
  fetchAll()
  void loadSkillEditorOptions()
  // 路由离开守卫之外，浏览器刷新/关闭也需要拦截（评审 #29）
  window.addEventListener('beforeunload', handleBeforeUnload)
})

// keep-alive 切回时刷新：离开时的路由守卫已对未保存修改强制确认，回到这里重拉是安全的；
// selectRole 会重置 dirty 状态
onActivated(async () => {
  const id = currentRole.value?.id
  await fetchAll()
  if (id != null) {
    const updated = roles.value.find((r) => r.id === id)
    if (updated) selectRole(updated)
  }
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (unsavedParts().length === 0) return
  event.preventDefault()
  // Chrome 需要 returnValue 才会弹出确认
  event.returnValue = ''
}

onBeforeRouteLeave(async () => confirmDiscard('离开'))
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.skill-hint {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.skill-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
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
  color: var(--mao-muted);
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
