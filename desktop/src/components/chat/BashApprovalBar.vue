<template>
  <div v-if="items.length > 0" class="bash-approval-bar">
    <div
      v-for="item in items"
      :key="item.requestId"
      class="approval-card"
    >
      <div class="approval-header">
        <el-icon class="approval-icon" :size="16"><WarningFilled /></el-icon>
        <span class="approval-title">命令执行待审批</span>
      </div>
      <p class="approval-desc">Agent 请求执行以下命令：</p>
      <pre class="command-preview"><code>{{ item.command }}</code></pre>
      <div class="approval-actions">
        <el-button class="pill-btn" @click="$emit('confirm', item.requestId, false)">拒绝</el-button>
        <el-button type="primary" class="pill-btn" @click="$emit('confirm', item.requestId, true)">允许执行</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { WarningFilled } from '@element-plus/icons-vue'

export interface BashApprovalItem {
  requestId: string
  command: string
}

defineProps<{
  items: BashApprovalItem[]
}>()

defineEmits<{
  confirm: [requestId: string, approved: boolean]
}>()
</script>

<style scoped>
.bash-approval-bar {
  flex-shrink: 0;
  margin-top: var(--aw-space-sm);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.approval-card {
  padding: 14px 16px;
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-warning);
  border-radius: var(--aw-radius-lg);
}

.approval-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.approval-icon {
  color: var(--aw-warning);
}

.approval-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.12px;
}

.approval-desc {
  margin: 0 0 var(--aw-space-xs);
  color: var(--aw-ink-muted-80);
  font-size: var(--aw-text-caption);
}

.command-preview {
  margin: 0 0 var(--aw-space-sm);
  padding: 10px 12px;
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

.approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}
</style>
