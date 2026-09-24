<template>
  <el-dialog
    :model-value="visible"
    title="重置密码"
    width="480px"
    append-to-body
    destroy-on-close
    @update:model-value="$emit('update:visible', $event)"
    @close="$emit('update:visible', false)"
  >
    <p class="user-hint">
      为用户 <strong>{{ username }}</strong> 设置新密码
    </p>
    <el-alert
      v-if="externalLoginLabel"
      type="info"
      :closable="false"
      show-icon
      class="source-hint"
    >
      该用户当前通过{{ externalLoginLabel }}登录。设置后可同时使用用户名和此密码登录，原登录方式仍然可用。账号类型会显示为「本地」。
    </el-alert>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="form.newPassword"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="至少 8 位，含字母和数字"
        />
      </el-form-item>
      <el-form-item label="确认密码" prop="confirmPassword">
        <el-input
          v-model="form.confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="再次输入新密码"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        确认重置
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const props = defineProps<{
  visible: boolean
  userId: number | null
  username: string
  authSource?: string | null
}>()

const AUTH_SOURCE_LABELS: Record<string, string> = {
  LDAP: 'LDAP',
  FEISHU: '飞书',
  ECP: 'ECP',
  COMPANY_SSO: '公司 SSO'
}

const externalLoginLabel = computed(() => {
  const source = props.authSource?.trim()
  if (!source || source === 'LOCAL') return ''
  return AUTH_SOURCE_LABELS[source] || source
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const submitting = ref(false)
const formRef = ref<FormInstance>()
const passwordPattern = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/

const form = reactive({
  newPassword: '',
  confirmPassword: ''
})

function validatePassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) {
    callback(new Error('请输入新密码'))
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
  if (value !== form.newPassword) {
    callback(new Error('两次输入的密码不一致'))
    return
  }
  callback()
}

const rules: FormRules = {
  newPassword: [{ validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [{ validator: validateConfirmPassword, trigger: 'blur' }]
}

watch(() => props.visible, (val) => {
  if (!val) return
  form.newPassword = ''
  form.confirmPassword = ''
  formRef.value?.clearValidate()
})

async function handleSubmit() {
  if (!props.userId) return

  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await api.put(`/users/${props.userId}/password`, {
      newPassword: form.newPassword,
      confirmPassword: form.confirmPassword
    })
    ElMessage.success(
      externalLoginLabel.value
        ? '已设置本地登录密码，请告知用户使用用户名和新密码登录'
        : '密码已重置，请告知用户尽快登录'
    )
    emit('update:visible', false)
    emit('saved')
  } catch {
    // Error handled by interceptor
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.user-hint {
  margin: 0 0 16px;
  color: #606266;
  font-size: 14px;
}

.source-hint {
  margin-bottom: 16px;
}
</style>
