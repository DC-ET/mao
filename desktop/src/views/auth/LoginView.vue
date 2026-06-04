<template>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <el-icon :size="24"><Monitor /></el-icon>
        </div>
        <h2 class="login-title">Agent Workbench</h2>
      </div>

      <el-form :model="form" @submit.prevent="handleLogin" class="login-form">
        <el-form-item>
          <el-radio-group v-model="form.authType" class="auth-type-group">
            <el-radio-button value="LDAP">LDAP 账号</el-radio-button>
            <el-radio-button value="LOCAL">本地账号</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.username"
            placeholder="用户名"
            prefix-icon="User"
            size="large"
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
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            size="large"
            class="login-btn"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Monitor } from '@element-plus/icons-vue'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const loading = ref(false)
const form = ref({
  username: '',
  password: '',
  authType: 'LDAP'
})

async function handleLogin() {
  if (!form.value.username || !form.value.password) return

  loading.value = true
  try {
    await authStore.login(form.value.username, form.value.password, form.value.authType)
    router.push('/')
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
  background: var(--aw-canvas-parchment);
}

.login-card {
  width: 400px;
  padding: 48px 40px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
}

.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}

.login-logo {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aw-primary);
  border-radius: var(--aw-radius-md);
  color: var(--aw-on-primary);
}

.login-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
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

.login-btn {
  width: 100%;
  border-radius: var(--aw-radius-pill) !important;
  font-size: var(--aw-text-body);
  font-weight: 400;
  padding: 11px 22px;
  height: auto;
}

.login-btn:active {
  transform: scale(0.95);
}

.auth-type-group {
  width: 100%;
  display: flex;
}

.auth-type-group :deep(.el-radio-button) {
  flex: 1;
}

.auth-type-group :deep(.el-radio-button__inner) {
  width: 100%;
}
</style>
