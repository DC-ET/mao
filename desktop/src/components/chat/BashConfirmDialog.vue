<template>
  <el-dialog
    :model-value="visible"
    title="命令执行确认"
    width="520px"
    :close-on-click-modal="false"
    @close="$emit('confirm', false)"
    class="bash-dialog"
  >
    <div class="confirm-body">
      <p class="confirm-desc">Agent 请求执行以下命令：</p>
      <pre class="command-preview"><code>{{ command }}</code></pre>
    </div>
    <template #footer>
      <el-button class="pill-btn" @click="$emit('confirm', false)">拒绝</el-button>
      <el-button type="primary" class="pill-btn" @click="$emit('confirm', true)">允许执行</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
  command: string
}>()

defineEmits<{
  confirm: [approved: boolean]
}>()
</script>

<style scoped>
.confirm-desc {
  margin: 0 0 var(--aw-space-sm);
  color: var(--aw-ink-muted-80);
  font-size: var(--aw-text-caption);
  letter-spacing: -0.224px;
}

.command-preview {
  margin: 0;
  padding: 14px 16px;
  background: var(--aw-ink);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
}

.command-preview code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: #d4d4d4;
  background: none;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}

:deep(.el-dialog) {
  border-radius: var(--aw-radius-lg);
}

:deep(.el-dialog__header) {
  padding: 20px 24px 0;
}

:deep(.el-dialog__title) {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  letter-spacing: 0.231px;
}

:deep(.el-dialog__body) {
  padding: 16px 24px;
}

:deep(.el-dialog__footer) {
  padding: 0 24px 20px;
}
</style>
