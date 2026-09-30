<template>
  <div v-if="showBanner" class="connection-banner" role="alert">
    连接已断开，正在自动重连…重连期间发送的消息将在恢复后继续处理
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStreamWS } from '../../composables/useStreamWS'

const { connected, everConnected } = useStreamWS()
// everConnected 区分「首次连接中」与「断线」：只在连上过又断开时展示，避免首屏加载闪现横幅
const showBanner = computed(() => everConnected.value && !connected.value)
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
</style>
