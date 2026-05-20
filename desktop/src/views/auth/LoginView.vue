<template>
  <div class="login-container">
    <el-card class="login-card">
      <template #header>
        <h2>Agent 工作台</h2>
      </template>

      <el-tabs v-model="loginType">
        <el-tab-pane label="LDAP 登录" name="ldap">
          <el-form :model="ldapForm" @submit.prevent="handleLdapLogin">
            <el-form-item>
              <el-input
                v-model="ldapForm.username"
                placeholder="用户名"
                prefix-icon="User"
              />
            </el-form-item>
            <el-form-item>
              <el-input
                v-model="ldapForm.password"
                type="password"
                placeholder="密码"
                prefix-icon="Lock"
                show-password
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :loading="loading"
                style="width: 100%"
                @click="handleLdapLogin"
              >
                登录
              </el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="飞书扫码登录" name="feishu">
          <div class="feishu-login">
            <p>请使用飞书 App 扫描二维码登录</p>
            <!-- TODO: Add Feishu QR code -->
            <el-button type="primary" @click="handleFeishuLogin">
              获取二维码
            </el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const loginType = ref('ldap')
const loading = ref(false)

const ldapForm = ref({
  username: '',
  password: ''
})

async function handleLdapLogin() {
  if (!ldapForm.value.username || !ldapForm.value.password) {
    return
  }

  loading.value = true
  try {
    await authStore.login(ldapForm.value.username, ldapForm.value.password)
    router.push('/')
  } finally {
    loading.value = false
  }
}

function handleFeishuLogin() {
  // TODO: Implement Feishu OAuth login
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
  width: 400px;
}

.login-card h2 {
  text-align: center;
  margin: 0;
  color: #303133;
}

.feishu-login {
  text-align: center;
  padding: 20px 0;
}

.feishu-login p {
  color: #606266;
  margin-bottom: 20px;
}
</style>
