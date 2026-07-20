<template>
  <div v-if="items.length > 0" class="approval-stack">
    <div class="stack-cards">
      <div
        v-for="(item, index) in items"
        :key="item.requestId"
        class="stack-card"
        :class="{ interactive: index === items.length - 1 }"
      >
        <!-- 非顶层：只显示标题行 -->
        <template v-if="index !== items.length - 1">
          <div class="card-row">
            <el-icon class="card-icon" :size="12"><WarningFilled /></el-icon>
            <span class="card-label">{{ titleMap[item.toolName] || '操作待审批' }}</span>
          </div>
        </template>

        <!-- 顶层：完整交互 -->
        <template v-else>
          <div class="card-row">
            <el-icon class="card-icon" :size="12"><WarningFilled /></el-icon>
            <span class="card-label">{{ titleMap[item.toolName] || '操作待审批' }}</span>
            <span v-if="items.length > 1" class="card-badge">{{ items.length }}</span>
          </div>
          <div class="command-line" :class="{ expanded: expandedSet.has(item.requestId) }">
            <code class="command-code">{{ displayText(item) }}</code>
          </div>
          <div v-if="item.dangerReason" class="danger-reason">
            {{ item.dangerReason }}
          </div>
          <div class="card-actions">
            <button
              v-if="item.description.length > threshold"
              class="cmd-link"
              @click.stop="toggleExpand(item.requestId)"
            >
              {{ expandedSet.has(item.requestId) ? '收起' : '展开' }}
            </button>
            <button class="cmd-link" @click.stop="copyText(item.description)">复制</button>
            <span class="actions-spacer" />
            <button class="action-btn reject" @click="$emit('confirm', item.requestId, false)">拒绝</button>
            <button class="action-btn approve" @click="$emit('confirm', item.requestId, true)">执行</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { WarningFilled } from '@element-plus/icons-vue'

export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  dangerReason?: string
}

const threshold = 120

const titleMap: Record<string, string> = {
  shell: '命令执行待审批',
  write_file: '文件写入待审批',
  edit_file: '文件编辑待审批'
}

defineProps<{
  items: ApprovalItem[]
}>()

defineEmits<{
  confirm: [requestId: string, approved: boolean]
}>()

const expandedSet = ref(new Set<string>())

function toggleExpand(requestId: string) {
  if (expandedSet.value.has(requestId)) {
    expandedSet.value.delete(requestId)
  } else {
    expandedSet.value.add(requestId)
  }
}

function displayText(item: ApprovalItem): string {
  if (item.description.length <= threshold) return item.description
  if (expandedSet.value.has(item.requestId)) return item.description
  return item.description.substring(0, threshold) + '...'
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}
</script>

<style scoped>
.approval-stack {
  flex-shrink: 0;
  margin-bottom: 8px;
  position: relative;
}

.stack-cards {
  position: relative;
}

.stack-card {
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-warning);
  border-radius: var(--aw-radius-md);
  padding: 10px 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  transition: transform 0.3s ease, opacity 0.3s ease;
}

/* 非顶层卡片堆叠效果 */
.stack-card:not(.interactive) {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}

.stack-card:nth-last-child(2):not(.interactive) {
  transform: translateY(-5px) scale(0.98);
  opacity: 0.55;
}

.stack-card:nth-last-child(3):not(.interactive) {
  transform: translateY(-10px) scale(0.96);
  opacity: 0.3;
}

.stack-card:nth-last-child(n+4):not(.interactive) {
  transform: translateY(-10px) scale(0.96);
  opacity: 0;
}

.stack-card.interactive {
  position: relative;
  z-index: 1;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.card-icon {
  color: var(--aw-warning);
  flex-shrink: 0;
}

.card-label {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink);
  flex: 1;
}

.card-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--aw-warning);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}

.command-line {
  margin-bottom: 8px;
  overflow: hidden;
}

.command-line.expanded {
  max-height: 200px;
  overflow-y: auto;
}

.command-code {
  display: block;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink);
  background: none;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.danger-reason {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid color-mix(in srgb, var(--aw-danger) 35%, var(--aw-hairline));
  background: color-mix(in srgb, var(--aw-danger) 6%, var(--aw-canvas));
  color: var(--aw-danger);
  font-size: var(--aw-text-fine);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cmd-link {
  background: none;
  border: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--aw-radius-xs);
}

.cmd-link:hover {
  background: rgba(0, 102, 204, 0.08);
}

.actions-spacer {
  flex: 1;
}

.action-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  transform: scale(1.04);
}

.action-btn:active {
  transform: scale(0.96);
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
