<template>
  <div class="login-container">
    <div class="login-card">
      <img class="login-logo" :src="logoSrc" alt="" />
      <h2>Mao 管理后台</h2>
      <p class="login-hint">平台配置、会话排障与权限治理</p>

      <el-form :model="form" @submit.prevent="handleLogin">
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

      <template v-if="ecpEnabled">
        <div class="login-divider">或</div>
        <div class="feishu-panel">
          <p class="feishu-status">{{ feishuStatusText }}</p>
          <el-button type="default" size="large" :loading="feishuLoading" style="width: 100%" @click="startFeishuLogin">
            飞书登录
          </el-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

const loading = ref(false)
const feishuLoading = ref(false)
const feishuStatusText = ref('请使用飞书登录')
const ecpEnabled = ref(false)
const rememberMe = ref(localStorage.getItem('rememberMe') === '1')
const form = ref({
  username: localStorage.getItem('rememberedUsername') ?? '',
  password: ''
})

let pollTimer: number | null = null
let feishuState = ''

localStorage.removeItem('rememberedPassword')

onMounted(async () => {
  document.title = '登录 · Mao 管理后台'
  try {
    const { data } = await api.get('/auth/features')
    ecpEnabled.value = Boolean(data?.ecpEnabled)
  } catch {
    ecpEnabled.value = false
  }
})

onBeforeUnmount(() => {
  clearPollTimer()
})

async function handleLogin() {
  if (loading.value) return
  if (!form.value.username || !form.value.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }

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

async function startFeishuLogin() {
  if (!ecpEnabled.value || feishuLoading.value) return
  feishuLoading.value = true
  feishuStatusText.value = '正在打开飞书授权页面…'
  try {
    const { data } = await api.post('/auth/ecp/feishu/start', { target: 'admin' })
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
    const { data } = await api.get('/auth/ecp/feishu/status', { params: { state: feishuState } })
    if (data.status === 'PENDING') {
      feishuStatusText.value = '等待飞书确认'
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
</style>
