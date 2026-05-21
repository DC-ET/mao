<template>
  <div class="activity-line" :class="[`type-${activity.type}`, `status-${activity.status}`]">
    <el-icon class="activity-icon" :size="12">
      <component :is="icon" />
    </el-icon>
    <span class="activity-summary">{{ activity.summary }}</span>
    <span v-if="activity.durationMs" class="activity-duration">{{ formatMs(activity.durationMs) }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Document, Edit, SetUp, Search, Monitor } from '@element-plus/icons-vue'

const props = defineProps<{
  activity: {
    id?: number
    type: string
    target?: string
    summary: string
    status?: string
    durationMs?: number
  }
}>()

const icon = computed(() => {
  switch (props.activity.type) {
    case 'READ': return Document
    case 'EDIT': return Edit
    case 'RUN': return SetUp
    case 'EXPLORE':
    case 'SEARCH': return Search
    default: return Monitor
  }
})

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<style scoped>
.activity-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  letter-spacing: -0.224px;
}

.activity-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.activity-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-duration {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.activity-line.status-error .activity-icon {
  color: var(--aw-danger);
}

.activity-line.status-error .activity-summary {
  color: var(--aw-danger);
}
</style>
