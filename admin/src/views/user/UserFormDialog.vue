<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="520px"
    @close="$emit('update:visible', false)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <el-form-item label="用户名" prop="username">
        <el-input
          v-model="form.username"
          :disabled="isEdit"
          placeholder="3-64 位字母、数字或下划线"
        />
      </el-form-item>
      <el-form-item label="显示名称" prop="displayName">
        <el-input v-model="form.displayName" placeholder="请输入显示名称" />
      </el-form-item>
      <el-form-item label="邮箱" prop="email">
        <el-input v-model="form.email" placeholder="选填" />
      </el-form-item>
      <template v-if="!isEdit">
        <el-form-item label="初始密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="至少 8 位，含字母和数字"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            placeholder="再次输入密码"
          />
        </el-form-item>
      </template>
      <el-form-item label="角色" prop="roleIds">
        <el-select
          v-model="form.roleIds"
          multiple
          placeholder="请选择角色"
          style="width: 100%"
        >
          <el-option
            v-for="role in roleOptions"
            :key="role.id"
            :label="role.name"
            :value="role.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-switch
          v-model="form.enabled"
          active-text="启用"
          inactive-text="禁用"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ submitButtonText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

interface RoleOption {
  id: number
  name: string
}

const props = withDefaults(defineProps<{
  visible: boolean
  userData?: any | null
  mode?: 'create' | 'edit'
}>(), {
  userData: null,
  mode: 'create'
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const isEdit = computed(() => props.mode === 'edit')
const dialogTitle = computed(() => (isEdit.value ? '编辑用户' : '新建用户'))
const submitButtonText = computed(() => (isEdit.value ? '保存' : '创建'))
const submitting = ref(false)
const formRef = ref<FormInstance>()
const roleOptions = ref<RoleOption[]>([])

const form = reactive({
  username: '',
  displayName: '',
  email: '',
  password: '',
  confirmPassword: '',
  roleIds: [] as number[],
  enabled: true
})

const passwordPattern = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/
const usernamePattern = /^[a-zA-Z0-9_]{3,64}$/

function validatePassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) {
    callback(new Error('请输入密码'))
    return
  }
  if (!passwordPattern.test(value)) {
    callback(new Error('密码须 8-64 位，且包含字母和数字'))
    return
  }
  callback()
}

function validateConfirmPassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) {
    callback(new Error('请再次输入密码'))
    return
  }
  if (value !== form.password) {
    callback(new Error('两次输入的密码不一致'))
    return
  }
  callback()
}

const rules = computed<FormRules>(() => {
  const base: FormRules = {
    username: [
      { required: true, message: '请输入用户名', trigger: 'blur' },
      {
        validator: (_rule, value, callback) => {
          if (!usernamePattern.test(value || '')) {
            callback(new Error('用户名须为 3-64 位字母、数字或下划线'))
            return
          }
          callback()
        },
        trigger: 'blur'
      }
    ],
    displayName: [{ required: true, message: '请输入显示名称', trigger: 'blur' }],
    email: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
    roleIds: [{ required: true, type: 'array', min: 1, message: '请至少选择一个角色', trigger: 'change' }]
  }

  if (!isEdit.value) {
    base.password = [{ validator: validatePassword, trigger: 'blur' }]
    base.confirmPassword = [{ validator: validateConfirmPassword, trigger: 'blur' }]
  }

  return base
})

function resetForm() {
  Object.assign(form, {
    username: '',
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
    roleIds: [] as number[],
    enabled: true
  })
}

async function fetchRoles() {
  const { data } = await api.get('/roles')
  roleOptions.value = data || []
}

watch(() => props.visible, async (val) => {
  if (!val) return

  await fetchRoles()

  if (props.userData && isEdit.value) {
    Object.assign(form, {
      username: props.userData.username || '',
      displayName: props.userData.displayName || '',
      email: props.userData.email || '',
      password: '',
      confirmPassword: '',
      roleIds: [...(props.userData.roleIds || [])],
      enabled: props.userData.status === 1
    })
  } else {
    resetForm()
    const defaultRole = roleOptions.value.find((r) => r.name === '普通用户')
    if (defaultRole) {
      form.roleIds = [defaultRole.id]
    }
  }

  formRef.value?.clearValidate()
})

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const status = form.enabled ? 1 : 0
    if (isEdit.value && props.userData?.id) {
      await api.put(`/users/${props.userData.id}`, {
        displayName: form.displayName,
        email: form.email,
        roleIds: form.roleIds,
        status
      })
      ElMessage.success('用户更新成功')
    } else {
      await api.post('/users', {
        username: form.username,
        displayName: form.displayName,
        email: form.email,
        password: form.password,
        roleIds: form.roleIds,
        status
      })
      ElMessage.success('用户创建成功')
    }
    emit('update:visible', false)
    emit('saved')
  } catch {
    // Error handled by interceptor
  } finally {
    submitting.value = false
  }
}
</script>
