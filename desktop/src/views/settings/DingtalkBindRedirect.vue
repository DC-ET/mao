<template>
  <div class="dingtalk-bind-redirect">正在跳转到钉钉授权…</div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { getToken } from '../../utils/auth-storage'
import { apiBaseUrl } from '../../utils/api-base'

const route = useRoute()

onMounted(() => {
  const state = String(route.params.state ?? '')
  const token = getToken()
  const base = apiBaseUrl()
  if (!state || !token) return
  window.location.replace(`${base}/dingtalk/bind/${encodeURIComponent(state)}?token=${encodeURIComponent(token)}`)
})
</script>

<style scoped>
.dingtalk-bind-redirect { padding: 48px 16px; text-align: center; color: var(--aw-ink-muted); }
</style>
