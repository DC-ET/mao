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
        <el-icon :size="16"><Message /></el-icon>
      </el-badge>
    </div>
  </el-tooltip>
  <InboxDrawer v-model="drawerVisible" />
</template>

<style scoped>
/* 与顶栏 .theme-toggle 同一套度量：28px 点击区（触屏下全局扩到 44px），图标 16px 垂直居中 */
.inbox-bell {
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

.inbox-bell:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-nav-text);
}

[data-theme="dark"] .inbox-bell:hover {
  background: rgba(255, 255, 255, 0.08);
}

/*
 * el-badge 是 inline-block，会带一条由 body 字号 × 行高撑起的 strut 行盒（约 25px），
 * 把 16px 图标顶到行盒上方 —— 顶栏里表现为图标比相邻图标高约 2.5px。
 * 这里把 badge 也收成居中弹性盒，图标回到点击区正中；徽标自身绝对定位不受影响。
 */
.inbox-bell :deep(.el-badge) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.inbox-bell :deep(.el-badge__content) {
  border: none;
}
</style>
