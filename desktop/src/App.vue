<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { dismissSplash, dismissSplashAfterPaint } from './utils/splash'
import { installExitFullScreenOnEscape } from './utils/exitFullScreenOnEscape'

const router = useRouter()
let detachExitFullScreen: (() => void) | undefined

onMounted(async () => {
  detachExitFullScreen = installExitFullScreenOnEscape()
  // 兜底：异常情况下最多 10 秒后强制移除 Splash
  window.setTimeout(() => dismissSplash(), 10_000)

  // 路由与懒加载页面就绪后即可移除 Splash，不必等待首屏 API
  await router.isReady()
  await nextTick()
  dismissSplashAfterPaint()
})

onUnmounted(() => {
  detachExitFullScreen?.()
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
