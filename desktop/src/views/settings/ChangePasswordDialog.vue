<template>
  <el-dialog
    :model-value="visible"
    title="修改密码"
    width="480px"
    class="change-password-dialog"
    append-to-body
    @update:model-value="$emit('update:visible', $event)"
    @closed="resetForm"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="当前密码" prop="oldPassword">
        <el-input
          v-model="form.oldPassword"
          type="password"
          show-password
          autocomplete="current-password"
          placeholder="输入当前密码"
        />
      </el-form-item>
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
      <div class="form-tip">改密后当前登录保持不变，其他已登录设备也无需重新登录。</div>
    </el-form>
    <template #footer>
      <button class="dialog-btn dialog-btn-cancel" @click="$emit('update:visible', false)">取消</button>
      <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit || submitting" @click="handleSubmit">
        {{ submitting ? '保存中…' : '确认修改' }}
      </button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { changeOwnPassword } from '../../api'

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

// 与后端 user.service.ts PASSWORD_PATTERN 保持一致，保存前先做前端校验
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/

const submitting = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

const canSubmit = computed(() =>
  form.oldPassword !== '' && form.newPassword !== '' && form.confirmPassword !== ''
)

function validateOldPassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) {
    callback(new Error('请输入当前密码'))
    return
  }
  callback()
}

function validateNewPassword(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) {
    callback(new Error('请输入新密码'))
    return
  }
  if (!PASSWORD_PATTERN.test(value)) {
    callback(new Error('密码须 8-64 位，且包含字母和数字'))
    return
  }
  if (value === form.oldPassword) {
    callback(new Error('新密码不能与当前密码相同'))
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
  oldPassword: [{ validator: validateOldPassword, trigger: 'blur' }],
  newPassword: [{ validator: validateNewPassword, trigger: 'blur' }],
  confirmPassword: [{ validator: validateConfirmPassword, trigger: 'blur' }]
}

function resetForm() {
  form.oldPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
  formRef.value?.clearValidate()
}

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await changeOwnPassword({
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
      confirmPassword: form.confirmPassword
    })
    ElMessage.success('密码已修改')
    emit('update:visible', false)
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.form-tip {
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.5;
}
</style>

<style>
.change-password-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}

.change-password-dialog .el-form-item__label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 4px !important;
}

.change-password-dialog .dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
}

.change-password-dialog .dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.change-password-dialog .dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.change-password-dialog .dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
