<template>
  <div class="layout">
    <TopNav />
    <main class="layout-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import TopNav from './TopNav.vue'
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.layout-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-canvas);
}
</style>
