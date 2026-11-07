<template>
  <div v-if="showBanner" class="connection-banner" :class="{ fatal: reconnectFailed }" role="alert">
    <template v-if="reconnectFailed">
      <span class="fatal-text">重连失败，网络或服务端异常</span>
      <span class="fatal-actions">
        <button type="button" class="fatal-btn" @click="manualReconnect">立即重试</button>
        <button type="button" class="fatal-btn" @click="reloadPage">重新加载页面</button>
      </span>
    </template>
    <template v-else>
      连接已断开，正在自动重连…重连期间发送的消息将在恢复后继续处理
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStreamWS } from '../../composables/useStreamWS'

const { connected, everConnected, reconnectFailed, manualReconnect } = useStreamWS()
// everConnected 区分「首次连接中」与「断线」：只在连上过又断开时展示，避免首屏加载闪现横幅
const showBanner = computed(() => everConnected.value && !connected.value)

function reloadPage() {
  window.location.reload()
}
</script>

<style scoped>
.connection-banner {
  padding: 6px 16px;
  text-align: center;
  font-size: 12px;
  line-height: 18px;
  color: #fff;
  background: var(--aw-warning);
  flex-shrink: 0;
}

.connection-banner.fatal {
  background: var(--aw-danger);
}

.fatal-text {
  margin-right: 10px;
}

.fatal-actions {
  display: inline-flex;
  gap: 10px;
}

.fatal-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  line-height: 18px;
  color: #fff;
  text-decoration: underline;
  cursor: pointer;
}

.fatal-btn:hover {
  opacity: 0.85;
}
</style>
