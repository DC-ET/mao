<template>
  <div v-if="message" class="execution-error-banner" role="alert">
    <div class="error-header">
      <el-icon class="error-icon" :size="14"><WarningFilled /></el-icon>
      <span class="error-title">执行异常</span>
    </div>
    <pre class="error-message">{{ message }}</pre>
  </div>
</template>

<script setup lang="ts">
import { WarningFilled } from '@element-plus/icons-vue'

defineProps<{
  message: string | null
}>()
</script>

<style scoped>
.execution-error-banner {
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--aw-danger) 35%, var(--aw-hairline));
  border-radius: var(--aw-radius-sm);
  background: color-mix(in srgb, var(--aw-danger) 6%, var(--aw-canvas));
}

.error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.error-icon {
  color: var(--aw-danger);
  flex-shrink: 0;
}

.error-title {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-danger);
}

.error-message {
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: var(--aw-text-caption);
  line-height: 1.45;
  color: var(--aw-ink-muted-80);
  max-height: 120px;
  overflow-y: auto;
}
</style>
