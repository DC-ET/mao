<template>
  <div v-if="items.length > 0" class="tool-approval-bar">
    <div
      v-for="item in items"
      :key="item.requestId"
      class="approval-card"
    >
      <div class="approval-header">
        <el-icon class="approval-icon" :size="16"><WarningFilled /></el-icon>
        <span class="approval-title">{{ titleMap[item.toolName] || '操作待审批' }}</span>
      </div>
      <p class="approval-desc">{{ descMap[item.toolName] || 'Agent 请求执行以下操作：' }}</p>
      <div v-if="item.dangerReason" class="danger-reason">
        <el-icon :size="14"><WarningFilled /></el-icon>
        <span>{{ item.dangerReason }}</span>
      </div>
      <div class="command-wrapper">
        <pre class="command-preview"><code>{{ item.description }}</code></pre>
        <button class="copy-btn" title="复制" @click="copyText(item.description)">
          <el-icon :size="14"><CopyDocument /></el-icon>
        </button>
      </div>
      <div class="approval-actions">
        <button class="action-btn reject" title="拒绝" @click="$emit('confirm', item.requestId, false)">
          <el-icon :size="16"><CloseBold /></el-icon>
        </button>
        <button class="action-btn approve" title="执行" @click="$emit('confirm', item.requestId, true)">
          <el-icon :size="16"><Check /></el-icon>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { WarningFilled, CopyDocument, CloseBold, Check } from '@element-plus/icons-vue'

export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  dangerReason?: string
}

const titleMap: Record<string, string> = {
  shell: '命令执行待审批',
  write_file: '文件写入待审批',
  edit_file: '文件编辑待审批'
}

const descMap: Record<string, string> = {
  shell: 'Agent 请求执行以下命令：',
  write_file: 'Agent 请求写入以下文件：',
  edit_file: 'Agent 请求编辑以下文件：'
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}

defineProps<{
  items: ApprovalItem[]
}>()

defineEmits<{
  confirm: [requestId: string, approved: boolean]
}>()
</script>

<style scoped>
.tool-approval-bar {
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

.danger-reason {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: var(--aw-space-xs);
  background: color-mix(in srgb, var(--aw-warning) 8%, transparent);
  border-radius: var(--aw-radius-sm);
  font-size: var(--aw-text-fine);
  color: var(--aw-warning);
  line-height: 1.5;
}

.danger-reason .el-icon {
  margin-top: 1px;
  flex-shrink: 0;
}

.command-wrapper {
  position: relative;
  margin-bottom: var(--aw-space-sm);
}

.command-preview {
  margin: 0;
  padding: 10px 12px;
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
}

.copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-glass);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.command-wrapper:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--aw-ink);
}

.command-preview code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
  white-space: pre;
}

.approval-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  transform: scale(1.08);
}

.action-btn:active {
  transform: scale(0.95);
}

.action-btn.reject {
  color: var(--aw-ink-muted-80);
}

.action-btn.reject:hover {
  border-color: var(--aw-danger);
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 6%, transparent);
}

.action-btn.approve {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 6%, transparent);
}

.action-btn.approve:hover {
  background: color-mix(in srgb, var(--aw-primary) 12%, transparent);
}
</style>
