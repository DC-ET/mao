<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useInboxStore } from '../../stores/inbox'
import { isMobileDevice } from '../../composables/usePanelLayout'
import InboxDrawer from './InboxDrawer.vue'

const inboxStore = useInboxStore()
const drawerVisible = ref(false)

// 首次挂载即拉一次权威未读数：徽标不能只依赖 WS onopen（弱网/WS 未连通时
// 刷新后仍要显示正确红点）。WS 推送与开抽屉重拉是后续的实时/兜底通道。
onMounted(() => {
  void inboxStore.fetchUnreadCount()
  // 偏好是系统通知的过滤依据（仅 Electron 消费），与未读数一并加载，
  // 避免 store 里的 preference 停留在初值、与设置页保存的结果脱节。
  void inboxStore.fetchInboxPreference()
})
</script>

<template>
  <el-tooltip content="站内收件箱" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
    <div
      class="inbox-bell"
      role="button"
      aria-label="站内收件箱"
      @click="drawerVisible = true"
    >
      <el-badge :value="inboxStore.unreadCount" :max="99" :hidden="inboxStore.unreadCount === 0">
        <el-icon :size="16"><Bell /></el-icon>
      </el-badge>
    </div>
  </el-tooltip>
  <InboxDrawer v-model="drawerVisible" />
</template>

<style scoped>
.inbox-bell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--aw-ink-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.inbox-bell:hover {
  background: var(--aw-hover-bg);
  color: var(--aw-ink);
}

.inbox-bell :deep(.el-badge__content) {
  border: none;
}
</style>
