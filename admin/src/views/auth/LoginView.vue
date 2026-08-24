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
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

const loading = ref(false)
const rememberMe = ref(localStorage.getItem('rememberMe') === '1')
const form = ref({
  username: localStorage.getItem('rememberedUsername') ?? '',
  password: ''
})

localStorage.removeItem('rememberedPassword')
onMounted(() => {
  document.title = '登录 · Mao 管理后台'
})

async function handleLogin() {
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
    router.push('/')
  } catch {
    // Error handled by interceptor
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--mao-canvas);
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  box-sizing: border-box;
}

.login-card {
  width: 380px;
  max-width: 100%;
  padding: 40px 32px 24px;
  background: var(--mao-surface);
  border: 1px solid var(--mao-border);
  border-radius: 16px;
  box-sizing: border-box;
}

.login-logo {
  display: block;
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  border-radius: 12px;
}

.login-card h2 {
  text-align: center;
  margin: 0 0 6px;
  color: var(--mao-ink);
  font-size: 22px;
  font-weight: 600;
}

.login-hint {
  margin: 0 0 28px;
  text-align: center;
  font-size: 13px;
  color: var(--mao-muted);
}
</style>
