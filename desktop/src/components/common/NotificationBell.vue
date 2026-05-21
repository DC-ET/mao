<template>
  <el-popover placement="bottom-end" :width="360" trigger="click" :teleported="false" @show="fetchNotifications">
    <template #reference>
      <el-badge :value="unreadCount" :hidden="unreadCount === 0" :max="99" class="notification-badge">
        <el-icon :size="18" class="notification-icon"><Bell /></el-icon>
      </el-badge>
    </template>

    <div class="notification-panel">
      <div class="notification-header">
        <span>通知</span>
        <button class="mark-read-btn" @click="markAllRead" :disabled="unreadCount === 0">
          全部已读
        </button>
      </div>

      <div class="notification-list" v-loading="loading">
        <div
          v-for="item in notifications"
          :key="item.id"
          :class="['notification-item', { unread: item.status === 0 }]"
          @click="handleRead(item)"
        >
          <div class="notification-title">{{ item.title }}</div>
          <div class="notification-content">{{ item.content }}</div>
          <div class="notification-time">{{ item.createdAt }}</div>
        </div>
        <el-empty v-if="notifications.length === 0 && !loading" description="暂无通知" :image-size="60" />
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '../../api'

const unreadCount = ref(0)
const notifications = ref<any[]>([])
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchUnreadCount() {
  try {
    const { data } = await api.get('/notifications/unread-count')
    unreadCount.value = data?.count || 0
  } catch {
    // silent
  }
}

async function fetchNotifications() {
  loading.value = true
  try {
    const { data } = await api.get('/notifications', { params: { page: 1, size: 20 } })
    notifications.value = data?.records || []
  } catch {
    // silent
  } finally {
    loading.value = false
  }
}

async function handleRead(item: any) {
  if (item.status === 0) {
    try {
      await api.put(`/notifications/${item.id}/read`)
      item.status = 1
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    } catch {
      // silent
    }
  }
}

async function markAllRead() {
  try {
    await api.put('/notifications/read-all')
    notifications.value.forEach(n => { n.status = 1 })
    unreadCount.value = 0
  } catch {
    // silent
  }
}

onMounted(() => {
  fetchUnreadCount()
  pollTimer = setInterval(fetchUnreadCount, 60000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<style scoped>
.notification-badge {
  cursor: pointer;
}

.notification-icon {
  color: var(--aw-body-muted);
  transition: color 0.15s;
}

.notification-icon:hover {
  color: var(--aw-body-on-dark);
}

.notification-panel {
  margin: -12px;
}

.notification-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px 10px;
  font-family: var(--aw-font-display);
  font-weight: 600;
  font-size: var(--aw-text-body);
  color: var(--aw-ink);
  letter-spacing: -0.374px;
}

.mark-read-btn {
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-caption);
  color: var(--aw-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--aw-radius-xs);
  transition: background 0.15s;
  letter-spacing: -0.224px;
}

.mark-read-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

.mark-read-btn:disabled {
  color: var(--aw-ink-muted-48);
  cursor: not-allowed;
}

.notification-list {
  max-height: 400px;
  overflow-y: auto;
}

.notification-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--aw-divider-soft);
  cursor: pointer;
  transition: background 0.15s;
}

.notification-item:hover {
  background: var(--aw-canvas-parchment);
}

.notification-item.unread {
  background: rgba(0, 102, 204, 0.05);
}

.notification-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  margin-bottom: 4px;
  letter-spacing: -0.224px;
}

.notification-content {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  letter-spacing: -0.12px;
}

.notification-time {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.08px;
}
</style>
