<template>
  <div class="login-container">
    <div class="login-card">
      <img class="login-logo" :src="logoSrc" alt="" />
      <h2>Mao 管理后台</h2>
      <p class="login-hint">平台配置、会话排障与权限治理</p>

      <el-form ref="formRef" :model="form" :rules="rules" @submit.prevent="handleLogin">
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="用户名"
            prefix-icon="User"
            size="large"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            prefix-icon="Lock"
            size="large"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="rememberMe">记住用户名</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            size="large"
            :loading="loading"
            style="width: 100%"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>

      <template v-if="feishuEnabled || ecpEnabled">
        <div class="login-divider">或</div>
        <div class="feishu-panel">
          <p class="feishu-status">{{ feishuStatusText }}</p>
          <el-button v-if="feishuEnabled" type="default" size="large" :loading="feishuLoading && activeProvider === 'mao'" @click="startFeishuLogin('mao')">
            飞书登录
          </el-button>
          <el-button v-if="ecpEnabled" type="default" size="large" :loading="feishuLoading && activeProvider === 'ecp'" @click="startFeishuLogin('ecp')">
            飞书登录(ECP)
          </el-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

const formRef = ref<FormInstance>()
const loading = ref(false)
const feishuLoading = ref(false)
const feishuStatusText = ref('请使用飞书登录')
const feishuEnabled = ref(false)
const ecpEnabled = ref(false)
const activeProvider = ref<'mao' | 'ecp'>('ecp')
const rememberMe = ref(localStorage.getItem('rememberMe') === '1')
const form = ref({
  username: localStorage.getItem('rememberedUsername') ?? '',
  password: ''
})

const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' }
  ]
}

let pollTimer: number | null = null
let feishuState = ''

onMounted(async () => {
  document.title = '登录 · Mao 管理后台'
  try {
    const { data } = await api.get('/auth/features', { skipErrorToast: true })
    feishuEnabled.value = Boolean(data?.feishuEnabled)
    ecpEnabled.value = Boolean(data?.ecpEnabled)
  } catch {
    feishuEnabled.value = false
    ecpEnabled.value = false
  }
})

onBeforeUnmount(() => {
  clearPollTimer()
})

async function handleLogin() {
  if (loading.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    await authStore.login(form.value.username, form.value.password)
    if (rememberMe.value) {
      localStorage.setItem('rememberMe', '1')
      localStorage.setItem('rememberedUsername', form.value.username)
    } else {
      localStorage.removeItem('rememberMe')
      localStorage.removeItem('rememberedUsername')
    }
    await router.replace('/')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || '登录失败')
  } finally {
    loading.value = false
  }
}

async function startFeishuLogin(provider: 'mao' | 'ecp') {
  if (provider === 'mao' && !feishuEnabled.value) return
  if (provider === 'ecp' && !ecpEnabled.value) return
  if (feishuLoading.value) return
  activeProvider.value = provider
  feishuLoading.value = true
  feishuStatusText.value = '正在打开飞书授权页面…'
  try {
    const { data } = provider === 'ecp'
      ? await api.post('/auth/ecp/feishu/start', { target: 'admin' }, { skipErrorToast: true })
      : await api.get('/auth/feishu/qrcode', { skipErrorToast: true })
    feishuState = data.state
    feishuStatusText.value = '请在打开的飞书授权页面中完成登录'
    window.open(data.authUrl || data.qrCodeUrl, '_blank', 'noopener,noreferrer')
    startPolling(data.pollInterval || 2)
  } catch (error: any) {
    feishuStatusText.value = '飞书登录启动失败'
    ElMessage.error(error?.response?.data?.message || error?.message || '飞书登录启动失败')
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

function clearPollTimer() {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function checkFeishuStatus() {
  if (!feishuState) return
  try {
    const statusPath = activeProvider.value === 'ecp' ? '/auth/ecp/feishu/status' : '/auth/feishu/status'
    const { data } = await api.get(statusPath, { params: { state: feishuState }, skipErrorToast: true })
    // PROCESSING 是回调换票中，不能停轮询，否则授权完成后页面一直停在失败文案。
    if (data.status === 'PENDING' || data.status === 'PROCESSING') {
      feishuStatusText.value = data.status === 'PROCESSING' ? '正在完成登录…' : '等待飞书确认'
      return
    }
    clearPollTimer()
    if (data.status === 'SUCCESS' && data.login) {
      authStore.token = data.login.accessToken
      localStorage.setItem('token', data.login.accessToken)
      localStorage.setItem('refreshToken', data.login.refreshToken)
      await authStore.fetchUserInfo()
      await router.replace('/')
      return
    }
    feishuStatusText.value = data.message || '飞书登录失败'
    ElMessage.error(feishuStatusText.value)
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || '飞书登录状态获取失败')
  }
}
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color-page);
}

.login-card {
  width: 400px;
  padding: 40px;
  border-radius: 12px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-light);
  text-align: center;
}

.login-logo {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
}

.login-hint {
  color: var(--el-text-color-secondary);
  margin-bottom: 24px;
}

.login-divider {
  margin: 20px 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.feishu-status {
  margin-bottom: 16px;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.feishu-panel .el-button {
  width: 100%;
  margin-left: 0;
}

.feishu-panel .el-button + .el-button {
  margin-top: 12px;
}
</style>
