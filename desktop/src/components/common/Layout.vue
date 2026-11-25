<template>
  <div class="layout">
    <TopNav />
    <ConnectionBanner />
    <main class="layout-main">
      <router-view />
    </main>
    <TerminalPanel />
  </div>
</template>

<script setup lang="ts">
import TopNav from './TopNav.vue'
import ConnectionBanner from './ConnectionBanner.vue'
import TerminalPanel from '../terminal/TerminalPanel.vue'
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  /* 移动浏览器的 100vh 大于实际可视高度（地址栏 / 工具栏），dvh 跟随动态视口；
     不支持 dvh 的旧 WebView 用上一行 100vh 兜底。 */
  height: 100dvh;
  overflow: hidden;
}

.layout-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-canvas);
}
</style>
