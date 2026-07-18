<template>
  <router-view />
</template>

<script setup lang="ts">
import { onErrorCaptured } from 'vue'
import { ElMessage } from 'element-plus'

// Global error boundary: surface unexpected render/runtime errors instead of
// letting a single broken route component blank the whole admin app.
onErrorCaptured((err) => {
  console.error('[admin] uncaught error:', err)
  ElMessage.error('页面发生异常，请刷新重试')
  return false
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
