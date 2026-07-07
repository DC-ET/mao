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
      :model="form"
      @submit.prevent="handleLogin"
      class="login-form"
    >
      <el-form-item>
        <el-input
          v-model="form.username"
          placeholder="用户名"
          prefix-icon="User"
          size="large"
          @keyup.enter="handleLogin"
        />
      </el-form-item>
      <el-form-item>
        <el-input
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
          :loading="passwordLoading"
          size="large"
          class="login-btn"
          @click="handleLogin"
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
        飞书扫码登录
      </el-button>
    </el-form>

    <div v-else class="feishu-panel">
      <div class="qr-frame">
        <el-icon v-if="feishuLoading" class="qr-loading" :size="32"><Loading /></el-icon>
        <img
          v-else-if="qrDataUrl"
          :src="qrDataUrl"
          alt="飞书登录二维码"
          class="qr-image"
        />
        <el-icon v-else class="qr-empty" :size="36"><Warning /></el-icon>
      </div>
      <p class="feishu-status">{{ feishuStatusText }}</p>
      <div class="feishu-actions">
        <el-button
          size="large"
          :disabled="!feishuAuthUrl"
          @click="openFeishuInBrowser"
        >
          浏览器打开
        </el-button>
        <el-button
          size="large"
          :loading="feishuLoading"
          @click="startFeishuLogin"
        >
          刷新
        </el-button>
      </div>
      <el-button class="password-entry" link @click="backToPasswordLogin">
        返回密码登录
      </el-button>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { useAuthStore } from '../../stores/auth'
import appIcon from '../../assets/app-icon-small.png'
import { useLoginDialog } from '../../composables/useLoginDialog'

type LoginMode = 'password' | 'feishu'
type ToastError = Error & { toastShown?: boolean }

const authStore = useAuthStore()
const { visible, close, notifySuccess } = useLoginDialog()

const mode = ref<LoginMode>('password')
const passwordLoading = ref(false)
const feishuLoading = ref(false)
const qrDataUrl = ref('')
const feishuAuthUrl = ref('')
const feishuState = ref('')
const feishuStatusText = ref('请使用飞书扫码确认登录')
const form = ref({
  username: '',
  password: ''
})

let pollTimer: number | null = null
let polling = false

onMounted(() => {
  void authStore.fetchAuthFeatures().catch(() => {
    authStore.features.feishuEnabled = false
  })
})

async function handleLogin() {
  if (!form.value.username || !form.value.password) return

  passwordLoading.value = true
  try {
    await authStore.login(form.value.username, form.value.password)
    form.value.username = ''
    form.value.password = ''
    notifySuccess()
  } finally {
    passwordLoading.value = false
  }
}

async function startFeishuLogin() {
  if (!authStore.features.feishuEnabled) return
  mode.value = 'feishu'
  clearPollTimer()
  qrDataUrl.value = ''
  feishuAuthUrl.value = ''
  feishuState.value = ''
  feishuStatusText.value = '正在生成二维码'
  feishuLoading.value = true

  try {
    const qr = await authStore.startFeishuLogin()
    feishuAuthUrl.value = qr.authUrl || qr.qrCodeUrl
    feishuState.value = qr.state
    qrDataUrl.value = await QRCode.toDataURL(qr.qrCodeUrl || qr.authUrl, {
      width: 220,
      margin: 1
    })
    feishuStatusText.value = '请使用飞书扫码确认登录'
    startPolling(qr.pollInterval || 2)
  } catch (error) {
    feishuStatusText.value = '二维码生成失败'
    showError(error, '飞书二维码生成失败')
  } finally {
    feishuLoading.value = false
  }
}

function startPolling(intervalSeconds: number) {
  clearPollTimer()
  void checkFeishuStatus()
  pollTimer = window.setInterval(() => {
    void checkFeishuStatus()
  }, Math.max(1, intervalSeconds) * 1000)
}

async function checkFeishuStatus() {
  if (!feishuState.value || polling) return
  polling = true
  try {
    const result = await authStore.pollFeishuLogin(feishuState.value)
    if (result.status === 'PENDING') {
      feishuStatusText.value = '等待飞书确认'
      return
    }
    clearPollTimer()
    if (result.status === 'SUCCESS') {
      feishuStatusText.value = '登录成功'
      resetFeishuLogin()
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

async function openFeishuInBrowser() {
  if (!feishuAuthUrl.value) return
  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(feishuAuthUrl.value)
    return
  }
  window.open(feishuAuthUrl.value, '_blank')
}

function backToPasswordLogin() {
  resetFeishuLogin()
  mode.value = 'password'
}

function handleClose() {
  resetFeishuLogin()
  close()
}

function resetFeishuLogin() {
  clearPollTimer()
  polling = false
  feishuLoading.value = false
  qrDataUrl.value = ''
  feishuAuthUrl.value = ''
  feishuState.value = ''
  feishuStatusText.value = '请使用飞书扫码确认登录'
}

function clearPollTimer() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function statusText(status: string) {
  if (status === 'EXPIRED') return '二维码已过期'
  if (status === 'FAILED') return '飞书登录失败'
  return '飞书登录未完成'
}

function showError(error: unknown, fallback: string) {
  if ((error as ToastError | undefined)?.toastShown) return
  ElMessage.error(error instanceof Error ? error.message : fallback)
}

onBeforeUnmount(() => {
  resetFeishuLogin()
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

.qr-frame {
  width: 232px;
  height: 232px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-lg);
  background: #fff;
}

.qr-image {
  width: 220px;
  height: 220px;
  display: block;
}

.qr-loading {
  color: var(--aw-muted);
  animation: spin 1s linear infinite;
}

.qr-empty {
  color: var(--aw-muted);
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

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
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
