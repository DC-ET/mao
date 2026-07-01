<template>
  <el-dialog
    v-model="visible"
    width="400px"
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

    <el-form :model="form" @submit.prevent="handleLogin" class="login-form">
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
          :loading="loading"
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
    </el-form>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../../stores/auth'
import appIcon from '../../assets/app-icon-small.png'
import { useLoginDialog } from '../../composables/useLoginDialog'

const authStore = useAuthStore()
const { visible, close, notifySuccess } = useLoginDialog()

const loading = ref(false)
const form = ref({
  username: '',
  password: ''
})

async function handleLogin() {
  if (!form.value.username || !form.value.password) return

  loading.value = true
  try {
    await authStore.login(form.value.username, form.value.password)
    form.value.username = ''
    form.value.password = ''
    notifySuccess()
  } finally {
    loading.value = false
  }
}

function handleClose() {
  close()
}
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

.login-form :deep(.login-actions) {
  margin-bottom: 0;
}

.login-actions {
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

.login-btn:active {
  transform: scale(0.95);
}

.cancel-btn {
  border-radius: var(--aw-radius-pill) !important;
  font-size: var(--aw-text-body);
  font-weight: 400;
  padding: 11px 22px;
  height: auto;
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
