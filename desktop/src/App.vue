<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { dismissSplash, dismissSplashAfterPaint } from './utils/splash'
import { useAppStatusIndicators } from './composables/useParallelStatus'
import { useBrowserLiveStore } from './stores/browserLive'
import { isElectronClient } from './utils/platform'

const router = useRouter()
// 多会话并行可见性（批次 29 提案 5）：浏览器标题态 + Electron 等待审批任务栏闪烁
useAppStatusIndicators()

// 浏览器直播（方案 2026-11-20 v2 D10）：两条 renderer（主窗 / 画中画窗）都经 App 挂载，
// 在此幂等绑定主进程枢纽的 IPC 一路。画中画双击放大 → 主进程 → 这里以 CustomEvent
// 扇出给 TaskView 打开直播 Tab（与 useStreamWS 的 CustomEvent 扇出模式一致）。
const browserLiveStore = useBrowserLiveStore()
browserLiveStore.bindMainProcess()
if (isElectronClient()) {
  ;(window as any).electronAPI?.browserLive?.onExpand?.((payload: { sessionId: number | null }) => {
    window.dispatchEvent(new CustomEvent('browser-live-expand', { detail: payload }))
  })
}

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
