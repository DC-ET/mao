<template>
  <ResponsiveDialog
    :model-value="visible"
    title="修改密码"
    width="480px"
    @update:model-value="$emit('update:visible', $event)"
    @close="$emit('update:visible', false)"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="self-hint"
      title="服务端未提供「校验旧密码」的自助改密接口，此处复用管理员重置密码接口直接设置新密码。"
    />
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
      <el-form-item label="确认新密码" prop="confirmPassword">
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
      <el-button type="primary" :loading="submitting" @click="handleSubmit">确认修改</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import { useAuthStore } from '../../stores/auth'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const authStore = useAuthStore()
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
    callback(new Error('请再次输入新密码'))
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

watch(
  () => props.visible,
  (val) => {
    if (!val) return
    form.newPassword = ''
    form.confirmPassword = ''
    formRef.value?.clearValidate()
  }
)

async function handleSubmit() {
  const userId = authStore.user?.id
  if (!userId) {
    ElMessage.error('用户信息未加载，请刷新页面后重试')
    return
  }
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await api.put(`/users/${userId}/password`, {
      newPassword: form.newPassword,
      confirmPassword: form.confirmPassword
    })
    ElMessage.success('密码已修改')
    emit('update:visible', false)
  } catch {
    // Error handled by interceptor
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.self-hint {
  margin-bottom: 16px;
}
</style>
