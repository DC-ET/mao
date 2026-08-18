<template>
  <el-dialog
    v-model="visible"
    width="420px"
    :show-close="true"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    :append-to-body="true"
    class="login-dialog"
    @close="handleClose"
  >
    <div class="login-header">
      <div class="login-logo">
        <img :src="appIcon" alt="Mao" class="login-logo-img" />
      </div>
      <h2 class="login-title">Mao</h2>
    </div>

    <el-form
      v-if="mode === 'password'"
      ref="formRef"
      :model="form"
      :rules="formRules"
      @submit.prevent="handleLogin"
      class="login-form"
    >
      <el-form-item prop="username">
        <el-input
          ref="usernameInputRef"
          v-model="form.username"
          placeholder="用户名"
          prefix-icon="User"
          size="large"
          @keyup.enter="handleLogin"
        />
      </el-form-item>
      <el-form-item prop="password">
        <el-input
          ref="passwordInputRef"
          v-model="form.password"
          type="password"
          placeholder="密码"
          prefix-icon="Lock"
          show-password
          size="large"
          @keyup.enter="handleLogin"
        />
      </el-form-item>
      <el-form-item class="login-actions">
        <el-button
          type="primary"
          native-type="submit"
          :loading="passwordLoading"
          size="large"
          class="login-btn"
        >
          登录
        </el-button>
        <el-button
          size="large"
          class="cancel-btn"
          @click="handleClose"
        >
          取消
        </el-button>
      </el-form-item>
      <el-button
        v-if="authStore.features.feishuEnabled"
        class="feishu-entry"
        size="large"
        plain
        @click="startFeishuLogin"
      >
        飞书登录
      </el-button>
    </el-form>

    <div v-else class="feishu-panel">
      <el-icon class="feishu-icon" :size="48"><Connection /></el-icon>
      <p class="feishu-status">{{ feishuStatusText }}</p>
      <div class="feishu-actions">
        <el-button
          size="large"
          type="primary"
          :loading="feishuLoading"
          @click="startFeishuLogin"
        >
          飞书登录
        </el-button>
      </div>
      <el-button class="password-entry" link @click="backToPasswordLogin">
        返回密码登录
      </el-button>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules, InputInstance } from 'element-plus'
import { useAuthStore } from '../../stores/auth'
import appIcon from '../../assets/app-icon-small.png'
import { useLoginDialog } from '../../composables/useLoginDialog'
import { getToken } from '../../utils/auth-storage'

type LoginMode = 'password' | 'feishu'

const authStore = useAuthStore()
const { visible, close, notifySuccess } = useLoginDialog()

const mode = ref<LoginMode>('password')
const passwordLoading = ref(false)
const feishuLoading = ref(false)
const feishuStatusText = ref('')
const formRef = ref<FormInstance>()
const usernameInputRef = ref<InputInstance>()
const passwordInputRef = ref<InputInstance>()
const form = ref({
  username: '',
  password: ''
})

const formRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

let pollTimer: number | null = null
let polling = false
let feishuState = ''

onMounted(() => {
  void authStore.fetchAuthFeatures().catch(() => {
    authStore.features.feishuEnabled = false
  })
})

async function handleLogin() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) {
    await nextTick()
    if (!form.value.username.trim()) {
      usernameInputRef.value?.focus()
    } else if (!form.value.password) {
      passwordInputRef.value?.focus()
    }
    return
  }

  passwordLoading.value = true
  try {
    await authStore.login(form.value.username, form.value.password)
    form.value.username = ''
    form.value.password = ''
    formRef.value?.clearValidate()
    notifySuccess()
  } finally {
    passwordLoading.value = false
  }
}

async function startFeishuLogin() {
  if (!authStore.features.feishuEnabled) return
  mode.value = 'feishu'
  feishuStatusText.value = '正在打开飞书授权页面…'
  feishuLoading.value = true

  try {
    const qr = await authStore.startFeishuLogin()
    const authUrl = qr.authUrl || qr.qrCodeUrl
    feishuState = qr.state

    if (window.electronAPI?.openFeishuAuthWindow) {
      // Electron: 内嵌窗口打开飞书授权页
      feishuStatusText.value = '请在打开的飞书授权窗口中完成登录'
      const result = await window.electronAPI.openFeishuAuthWindow(authUrl)
      if (result.state) {
        feishuStatusText.value = '登录成功，正在获取用户信息…'
        await pollFeishuResult(feishuState)
      } else {
        feishuStatusText.value = '授权窗口已关闭'
        backToPasswordLogin()
      }
    } else {
      // Web: 新窗口打开飞书授权页
      feishuStatusText.value = '请在打开的飞书授权页面中完成登录'
      window.open(authUrl, '_blank')
      startPolling(qr.pollInterval || 2)
    }
  } catch (error) {
    feishuStatusText.value = '飞书登录启动失败'
    showError(error, '飞书登录启动失败')
  } finally {
    feishuLoading.value = false
  }
}

function startPolling(intervalSeconds: number) {
  clearPollTimer()
  pollTimer = window.setInterval(() => {
    void checkFeishuStatus()
  }, Math.max(1, intervalSeconds) * 1000)
}

async function checkFeishuStatus() {
  if (!feishuState || polling) return
  polling = true
  try {
    const result = await authStore.pollFeishuLogin(feishuState)
    if (result.status === 'PENDING') {
      feishuStatusText.value = '等待飞书确认'
      return
    }
    clearPollTimer()
    if (result.status === 'SUCCESS') {
      feishuStatusText.value = '登录成功'
      feishuState = ''
      notifySuccess()
      return
    }
    feishuStatusText.value = result.message || statusText(result.status)
  } catch (error) {
    clearPollTimer()
    feishuStatusText.value = '登录状态获取失败'
    showError(error, '飞书登录状态获取失败')
  } finally {
    polling = false
  }
}

async function pollFeishuResult(state: string) {
  // Wait for the server-side callback to complete, then poll for result
  await new Promise(resolve => setTimeout(resolve, 1500))
  let attempts = 0
  const maxAttempts = 30
  while (attempts < maxAttempts) {
    attempts++
    try {
      const result = await authStore.pollFeishuLogin(state)
      if (result.status === 'SUCCESS') {
        feishuStatusText.value = '登录成功'
        notifySuccess()
        return
      }
      if (result.status === 'FAILED' || result.status === 'EXPIRED') {
        feishuStatusText.value = result.message || statusText(result.status)
        showError(new Error(feishuStatusText.value), '飞书登录失败')
        backToPasswordLogin()
        return
      }
    } catch {
      // continue polling
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  feishuStatusText.value = '登录超时'
  backToPasswordLogin()
}

function backToPasswordLogin() {
  clearPollTimer()
  mode.value = 'password'
  feishuState = ''
  feishuStatusText.value = ''
}

function handleClose() {
  if (!getToken()) {
    ElMessage.warning('需登录才能使用完整功能')
  }
  clearPollTimer()
  feishuState = ''
  feishuLoading.value = false
  feishuStatusText.value = ''
  mode.value = 'password'
  close()
}

function clearPollTimer() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  polling = false
}

function statusText(status: string) {
  if (status === 'EXPIRED') return '二维码已过期'
  if (status === 'FAILED') return '飞书登录失败'
  return '飞书登录未完成'
}

function showError(error: unknown, fallback: string) {
  if ((error as { toastShown?: boolean } | undefined)?.toastShown) return
  ElMessage.error(error instanceof Error ? error.message : fallback)
}

onBeforeUnmount(() => {
  clearPollTimer()
})
</script>

<style scoped>
.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}

.login-logo {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-logo-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: var(--aw-radius-lg);
}

.login-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0;
}

.login-form {
  width: 100%;
}

.login-form :deep(.el-input__wrapper) {
  border-radius: var(--aw-radius-pill);
  padding: 4px 16px;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 20px;
}

.login-form :deep(.login-actions) {
  margin-bottom: 0;
}

.login-actions,
.feishu-actions {
  display: flex;
  gap: 12px;
}

.login-btn {
  flex: 1;
  border-radius: var(--aw-radius-pill) !important;
  font-size: var(--aw-text-body);
  font-weight: 400;
  padding: 11px 22px;
  height: auto;
}

.login-btn:active,
.feishu-entry:active,
.cancel-btn:active {
  transform: scale(0.95);
}

.cancel-btn {
  border-radius: var(--aw-radius-pill) !important;
  font-size: var(--aw-text-body);
  font-weight: 400;
  padding: 11px 22px;
  height: auto;
}

.feishu-entry {
  width: 100%;
  margin-top: 16px;
  border-radius: var(--aw-radius-pill) !important;
}

.feishu-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

.feishu-icon {
  color: var(--aw-ink-secondary, #6b7280);
}

.feishu-status {
  min-height: 22px;
  margin: 0;
  color: var(--aw-muted);
  font-size: var(--aw-text-caption);
  line-height: 22px;
  text-align: center;
}

.feishu-actions {
  width: 100%;
}

.feishu-actions .el-button {
  flex: 1;
  border-radius: var(--aw-radius-pill) !important;
}

.password-entry {
  padding: 0;
}
</style>

<style>
.login-dialog .el-dialog__header {
  display: none;
}

.login-dialog .el-dialog__body {
  padding: 40px 40px 32px;
}
</style>
