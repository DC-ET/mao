<template>
  <div class="callback-page">
    <p>{{ statusText }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const statusText = ref('正在完成飞书登录…')

onMounted(() => {
  document.title = '飞书登录 · Mao 管理后台'
  void completeLogin()
})

async function completeLogin() {
  const state = String(route.query.state ?? '')
  const code = String(route.query.code ?? '')
  if (!state || !code) {
    statusText.value = '缺少授权参数'
    ElMessage.error('飞书回调参数不完整')
    await router.replace('/login')
    return
  }
  try {
    const { data } = await api.post('/auth/ecp/feishu/callback', { state, code })
    authStore.token = data.accessToken
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
    await authStore.fetchUserInfo()
    statusText.value = '登录成功，正在跳转…'
    await router.replace('/')
  } catch (error: any) {
    statusText.value = '登录失败'
    ElMessage.error(error?.response?.data?.message || error?.message || '飞书登录失败')
    await router.replace('/login')
  }
}
</script>

<style scoped>
.callback-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-regular);
}
</style>
