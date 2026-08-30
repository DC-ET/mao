<template>
  <div class="login-page">
    <div class="login-topbar" aria-hidden="true" />
    <div class="login-theme-toggle">
      <div class="theme-toggle" role="button" :aria-label="themeTooltip" @click="toggleTheme">
        <el-icon :size="16">
          <Sunrise v-if="theme === 'auto'" />
          <Moon v-else-if="theme === 'light'" />
          <Sunny v-else />
        </el-icon>
      </div>
    </div>

    <div class="login-card">
      <div class="login-header">
        <img :src="appIcon" alt="Mao" class="login-logo-img" />
        <h2 class="login-title">Mao</h2>
      </div>

      <el-form
        v-if="mode === 'password'"
        ref="formRef"
        :model="form"
        :rules="formRules"
        class="login-form"
        @submit.prevent="handleLogin"
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
        <el-form-item class="remember-item">
          <el-checkbox v-model="rememberUsername">记住用户名</el-checkbox>
        </el-form-item>
        <el-form-item class="submit-item">
          <el-button
            type="primary"
            native-type="submit"
            :loading="passwordLoading"
            size="large"
            class="login-btn"
          >
            登录
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
        <el-button
          size="large"
          type="primary"
          :loading="feishuLoading"
          @click="startFeishuLogin"
        >
          飞书登录
        </el-button>
        <el-button class="password-entry" link @click="backToPasswordLogin">
          返回密码登录
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Sunrise, Moon, Sunny } from '@element-plus/icons-vue'
import type { FormInstance, FormRules, InputInstance } from 'element-plus'
import { useAuthStore } from '../../stores/auth'
import appIcon from '../../assets/app-icon-small.png'
import { useTheme } from '../../utils/theme'
import { readRedirectQuery, safeRedirect } from '../../utils/login-redirect'

type LoginMode = 'password' | 'feishu'

const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()
const { theme, toggleTheme } = useTheme()

const themeTooltip = computed(() => {
  if (theme.value === 'auto') return '跟随系统（点击切换浅色）'
  if (theme.value === 'light') return '浅色（点击切换深色）'
  return '深色（点击跟随系统）'
})

const mode = ref<LoginMode>('password')
const passwordLoading = ref(false)
const feishuLoading = ref(false)
const feishuStatusText = ref('')
const rememberUsername = ref(localStorage.getItem('rememberMe') === '1')
const formRef = ref<FormInstance>()
const usernameInputRef = ref<InputInstance>()
const passwordInputRef = ref<InputInstance>()
const form = ref({
  username: localStorage.getItem('rememberedUsername') ?? '',
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

onMounted(() => {
  document.title = 'Mao'
})

/** 登录成功后的统一出口：回跳 redirect 或首页（已登录访问 /login 的守卫也会走这里）。 */
async function finishLogin() {
  const target = safeRedirect(readRedirectQuery(route.query))
  await router.replace(target)
}

async function handleLogin() {
  if (passwordLoading.value) return
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
    saveRememberedUsername()
    form.value.username = ''
    form.value.password = ''
    formRef.value?.clearValidate()
    await finishLogin()
  } catch (error: any) {
    // /auth/login 的 401 拦截器不弹 toast，这里兜底展示失败原因
    ElMessage.error(error?.response?.data?.message || error?.message || '登录失败，请检查用户名和密码')
  } finally {
    passwordLoading.value = false
  }
}

function saveRememberedUsername() {
  if (rememberUsername.value) {
    localStorage.setItem('rememberMe', '1')
    localStorage.setItem('rememberedUsername', form.value.username.trim())
  } else {
    localStorage.removeItem('rememberMe')
    localStorage.removeItem('rememberedUsername')
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
      // Web / 安卓: 新窗口打开飞书授权页，轮询状态
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
      await finishLogin()
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
        await finishLogin()
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
.login-page {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--aw-canvas);
  padding: 16px;
  box-sizing: border-box;
}

/* Electron 红绿灯避让 + 可拖拽顶栏；Web/安卓为透明占位 */
.login-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--aw-nav-height);
  -webkit-app-region: drag;
}

.login-theme-toggle {
  position: absolute;
  top: 6px;
  right: 12px;
  z-index: 10;
  -webkit-app-region: no-drag;
}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-nav-text-muted);
  transition: color 0.15s, background 0.15s;
}

.theme-toggle:hover {
  color: var(--aw-nav-text);
  background: rgba(0, 0, 0, 0.06);
}

[data-theme="dark"] .theme-toggle:hover {
  background: rgba(255, 255, 255, 0.08);
}

.login-card {
  width: 380px;
  max-width: 100%;
  padding: 40px 32px 24px;
  background: var(--aw-surface);
  border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-lg);
  box-sizing: border-box;
}

.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}

.login-logo-img {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border-radius: var(--aw-radius-lg);
}

.login-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
}

.login-form :deep(.el-input__wrapper) {
  border-radius: var(--aw-radius-pill);
  padding: 4px 16px;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 20px;
}

.remember-item {
  margin-bottom: 12px !important;
}

.submit-item {
  margin-bottom: 0 !important;
}

.login-btn {
  width: 100%;
  border-radius: var(--aw-radius-pill) !important;
  font-size: var(--aw-text-body);
  font-weight: 400;
  padding: 11px 22px;
  height: auto;
}

.login-btn:active,
.feishu-entry:active {
  transform: scale(0.95);
}

.feishu-entry {
  width: 100%;
  margin-top: 4px;
  border-radius: var(--aw-radius-pill) !important;
}

.feishu-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

.feishu-icon {
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

.feishu-panel .el-button[type="primary"],
.feishu-panel > .el-button:not(.password-entry) {
  width: 100%;
  border-radius: var(--aw-radius-pill) !important;
}

.password-entry {
  padding: 0;
}
</style>
