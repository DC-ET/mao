<script setup lang="ts">
import { Odometer } from '@element-plus/icons-vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { isMobileDevice } from '../../composables/usePanelLayout'
import UsageDrawer from './UsageDrawer.vue'

const drawerVisible = ref(false)

/** 摘要详情对话框等跨组件入口：dispatch window 事件 'open_usage_drawer' 打开用量抽屉。 */
function handleOpenUsageDrawer() {
  drawerVisible.value = true
}

onMounted(() => window.addEventListener('open_usage_drawer', handleOpenUsageDrawer))
onUnmounted(() => window.removeEventListener('open_usage_drawer', handleOpenUsageDrawer))
</script>

<template>
  <el-tooltip content="我的用量" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
    <div
      class="usage-bell"
      role="button"
      aria-label="我的用量"
      @click="drawerVisible = true"
    >
      <el-icon :size="16"><Odometer /></el-icon>
    </div>
  </el-tooltip>
  <UsageDrawer v-model="drawerVisible" />
</template>

<style scoped>
/* 与顶栏 .theme-toggle / .inbox-bell 同一套度量：28px 点击区（触屏下全局扩到 44px），图标 16px 垂直居中 */
.usage-bell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-nav-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.usage-bell:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-nav-text);
}

[data-theme="dark"] .usage-bell:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
