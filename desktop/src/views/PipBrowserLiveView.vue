<template>
  <div class="pip-live-page">
    <BrowserLiveView variant="pip" />
  </div>
</template>

<script setup lang="ts">
/**
 * 画中画窗口页（方案 2026-11-20 v2 D4）：frameless 独立窗口加载 /pip 路由。
 * 与主窗同源同 partition（localStorage 共享，auth 直接可用，路由 guard 正常走）。
 */
import BrowserLiveView from '../components/browser/BrowserLiveView.vue'
</script>

<style scoped>
.pip-live-page {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #101014;
}
</style>
