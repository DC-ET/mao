<template>
  <!-- 发送媒体投递条（统一发送媒体方案 2026-11-18 D6/§7.1）：该轮 send_image / send_file 的
       会话副本画在最终回复下方、文件变更面板同一层。图片进网格（点击大图预览），文件出链接。 -->
  <div v-if="deliveries.length > 0" class="chat-delivery-bar">
    <div v-if="imageDeliveries.length > 0" class="delivery-images">
      <el-image
        v-for="(d, idx) in imageDeliveries"
        :key="d.url"
        :src="d.url"
        :preview-src-list="imageUrls"
        :initial-index="idx"
        :alt="d.filename"
        :title="d.filename"
        fit="cover"
        class="delivery-image"
        :preview-teleported="true"
      />
    </div>
    <div v-if="fileDeliveries.length > 0" class="delivery-files">
      <a
        v-for="d in fileDeliveries"
        :key="d.url"
        class="delivery-file"
        :href="d.url"
        target="_blank"
        rel="noopener"
      >
        <el-icon class="delivery-file-icon" :size="14"><Document /></el-icon>
        <span class="delivery-file-name">{{ d.filename }}</span>
        <span v-if="d.bytes != null" class="delivery-file-size">{{ formatSize(d.bytes) }}</span>
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Document } from '@element-plus/icons-vue'
import type { SendDelivery } from '../../types/chat'
import { formatSize } from '../../utils/file-manager'

const props = defineProps<{
  deliveries: SendDelivery[]
}>()

const imageDeliveries = computed(() => props.deliveries.filter(d => d.kind === 'image'))
const imageUrls = computed(() => imageDeliveries.value.map(d => d.url))
const fileDeliveries = computed(() => props.deliveries.filter(d => d.kind !== 'image'))
</script>

<style scoped>
.chat-delivery-bar {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.delivery-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.delivery-image {
  width: 96px;
  height: 96px;
  border-radius: var(--aw-radius-xs);
  cursor: zoom-in;
}

.delivery-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.delivery-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  text-decoration: none;
  transition: background 0.15s;
}

.delivery-file:hover {
  background: var(--aw-divider-soft);
}

.delivery-file-icon {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.delivery-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delivery-file-size {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}
</style>
