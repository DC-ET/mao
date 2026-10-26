<script setup lang="ts">
import { Odometer } from '@element-plus/icons-vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { isMobileDevice } from '../../composables/usePanelLayout'
import UsageDrawer from './UsageDrawer.vue'
import type { UsageTab } from './UsageDrawer.vue'

const drawerVisible = ref(false)
/**
 * 跨组件打开请求：{ tab, nonce }。nonce 自增——连续两次派发同一个 Tab
 * （如重复点击收件箱里的两条预算提醒）watch 浅比较也能触发（C8）。
 */
const openRequest = ref<{ tab: UsageTab; nonce: number } | null>(null)
let openNonce = 0

/**
 * 摘要详情对话框 / 收件箱预算提醒等跨组件入口：dispatch window 事件 'open_usage_drawer' 打开用量抽屉。
 * detail.tab 可选：不带 detail 的存量派发（摘要「查看用量」）只开抽屉不改 Tab，行为逐字节不变。
 */
function handleOpenUsageDrawer(e: Event) {
  drawerVisible.value = true
  const tab = (e as CustomEvent<{ tab?: UsageTab }>).detail?.tab
  if (tab) openRequest.value = { tab, nonce: ++openNonce }
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
  <UsageDrawer v-model="drawerVisible" :open-request="openRequest" />
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
