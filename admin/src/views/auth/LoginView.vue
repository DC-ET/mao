<template>
  <div class="login-container">
    <el-card class="login-card">
      <template #header>
        <div class="login-brand">
          <img class="login-logo" :src="logoSrc" alt="" />
          <h2>Mao 管理后台</h2>
        </div>
      </template>

      <el-form :model="form" @submit.prevent="handleLogin">
        <el-form-item>
          <el-input
            v-model="form.username"
            placeholder="用户名"
            prefix-icon="User"
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
            :loading="loading"
            style="width: 100%"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
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
  background: #f5f7fa;
  padding: 16px;
  box-sizing: border-box;
}

.login-card {
  width: 400px;
  max-width: 100%;
}

.login-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.login-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.login-card h2 {
  text-align: center;
  margin: 0;
  color: #303133;
  font-size: 18px;
}
</style>
