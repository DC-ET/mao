<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { dismissSplash, dismissSplashAfterPaint } from './utils/splash'
import { useAppStatusIndicators } from './composables/useParallelStatus'

const router = useRouter()
// 多会话并行可见性（批次 29 提案 5）：浏览器标题态 + Electron 等待审批任务栏闪烁
useAppStatusIndicators()

onMounted(async () => {
  // 兜底：异常情况下最多 10 秒后强制移除 Splash
  window.setTimeout(() => dismissSplash(), 10_000)

  // 路由与懒加载页面就绪后即可移除 Splash，不必等待首屏 API
  await router.isReady()
  await nextTick()
  dismissSplashAfterPaint()
})
</script>

<style>
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
}

#app {
  height: 100%;
}
</style>
