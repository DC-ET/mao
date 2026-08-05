<template>
  <div class="compaction-marker" role="status">
    <span class="compaction-marker-line" aria-hidden="true"></span>
    <span class="compaction-marker-label">
      {{ triggerLabel }}
      <template v-if="savedLabel"> · {{ savedLabel }}</template>
    </span>
    <span class="compaction-marker-line" aria-hidden="true"></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CompactionEvent } from '../../types/chat'

const props = defineProps<{
  event: CompactionEvent
}>()

const triggerLabel = computed(() => {
  if (props.event.triggerMode === 'mid_loop') return '执行中整理上下文'
  if (props.event.triggerMode === 'request_start') return '回复前整理上下文'
  return '已整理上下文'
})

const savedLabel = computed(() => {
  const saved = props.event.savedTokens
  if (!saved || saved <= 0) return ''
  if (saved < 1000) return `约节省 ${saved} tokens`
  if (saved < 10000) return `约节省 ${(saved / 1000).toFixed(1).replace(/\.0$/, '')}k tokens`
  return `约节省 ${Math.round(saved / 1000)}k tokens`
})
</script>

<style scoped>
.compaction-marker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 14px;
  padding: 0 4px;
}

.compaction-marker-line {
  flex: 1;
  height: 1px;
  background: var(--aw-divider-soft);
}

.compaction-marker-label {
  flex-shrink: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
  white-space: nowrap;
}
</style>
