<template>
  <div class="role-permission">
    <el-row :gutter="16">
      <el-col :span="10">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>角色列表</span>
              <el-button type="primary" @click="handleCreateRole">
                <el-icon><Plus /></el-icon>
                新建角色
              </el-button>
            </div>
          </template>

          <el-table :data="roles" v-loading="loading" stripe @row-click="selectRole">
            <el-table-column prop="name" label="角色" min-width="120" />
            <el-table-column prop="code" label="编码" width="110" />
            <el-table-column prop="userCount" label="用户数" width="80" align="right" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button type="primary" link size="small" @click.stop="handleEditRole(row)">编辑</el-button>
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
              <el-button type="primary" :disabled="!currentRole" @click="savePermissions">保存权限</el-button>
            </div>
          </template>

          <el-empty v-if="!currentRole" description="请选择左侧角色" />
          <div v-else>
            <div class="role-title">
              <strong>{{ currentRole.name }}</strong>
              <el-tag size="small">{{ currentRole.code }}</el-tag>
            </div>
            <el-checkbox-group v-model="selectedPermissionIds" class="permission-grid">
              <el-checkbox
                v-for="permission in permissions"
                :key="permission.id"
                :label="permission.id"
                border
              >
                <span>{{ permission.name }}</span>
                <small>{{ permission.code }}</small>
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" :title="dialogMode === 'create' ? '新建角色' : '编辑角色'" width="480px">
      <el-form :model="roleForm" label-width="90px">
        <el-form-item label="角色名称">
          <el-input v-model="roleForm.name" placeholder="例如：运营管理员" />
        </el-form-item>
        <el-form-item label="角色编码">
          <el-input v-model="roleForm.code" :disabled="dialogMode === 'edit'" placeholder="例如：OPS_ADMIN" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleForm.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveRole">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

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
const roles = ref<Role[]>([])
const permissions = ref<Permission[]>([])
const currentRole = ref<Role | null>(null)
const selectedPermissionIds = ref<number[]>([])
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const roleForm = reactive({
  id: 0,
  name: '',
  code: '',
  description: ''
})

async function fetchAll() {
  loading.value = true
  try {
    const [roleRes, permissionRes] = await Promise.all([
      api.get('/roles'),
      api.get('/permissions')
    ])
    roles.value = roleRes.data || []
    permissions.value = permissionRes.data || []
    if (!currentRole.value && roles.value.length > 0) {
      selectRole(roles.value[0])
    }
  } finally {
    loading.value = false
  }
}

function selectRole(role: Role) {
  currentRole.value = role
  selectedPermissionIds.value = [...(role.permissionIds || [])]
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

async function saveRole() {
  if (dialogMode.value === 'create') {
    await api.post('/roles', roleForm)
    ElMessage.success('角色已创建')
  } else {
    await api.put(`/roles/${roleForm.id}`, roleForm)
    ElMessage.success('角色已更新')
  }
  dialogVisible.value = false
  await fetchAll()
}

async function savePermissions() {
  if (!currentRole.value) return
  await api.put(`/roles/${currentRole.value.id}/permissions`, {
    permissionIds: selectedPermissionIds.value
  })
  ElMessage.success('权限已保存')
  // Keep the current role selected and refresh so checkbox state stays in sync
  const id = currentRole.value.id
  await fetchAll()
  const updated = roles.value.find(r => r.id === id)
  if (updated) selectRole(updated)
}

onMounted(fetchAll)
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
</style>
