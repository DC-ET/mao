<template>
  <el-popover placement="bottom-end" :width="360" trigger="click" :teleported="false" @show="fetchNotifications">
    <template #reference>
      <el-badge :value="unreadCount" :hidden="unreadCount === 0" :max="99" class="notification-badge">
        <el-icon :size="20" class="notification-icon"><Bell /></el-icon>
      </el-badge>
    </template>

    <div class="notification-panel">
      <div class="notification-header">
        <span>通知</span>
        <el-button type="primary" link size="small" @click="markAllRead" :disabled="unreadCount === 0">
          全部已读
        </el-button>
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
  color: #606266;
}

.notification-icon:hover {
  color: #409eff;
}

.notification-panel {
  margin: -12px;
}

.notification-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #ebeef5;
  font-weight: 600;
}

.notification-list {
  max-height: 400px;
  overflow-y: auto;
}

.notification-item {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: background 0.2s;
}

.notification-item:hover {
  background: #f5f7fa;
}

.notification-item.unread {
  background: #ecf5ff;
}

.notification-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 4px;
}

.notification-content {
  font-size: 12px;
  color: #909399;
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notification-time {
  font-size: 11px;
  color: #c0c4cc;
}
</style>
