<template>
  <div class="task-inspector">
    <div class="inspector-section">
      <h4 class="section-title">进度</h4>
      <TodoChecklist :todos="todos" />
    </div>

    <div class="inspector-section">
      <h4 class="section-title">工作区</h4>
      <div class="workspace-info">
        <span class="workspace-path">{{ workspace || '未设置' }}</span>
        <span class="workspace-mode">
          <span class="mode-dot" :class="wsConnected ? 'connected' : 'disconnected'"></span>
          {{ executionMode === 'LOCAL' ? (wsConnected ? '本地已连接' : '本地未连接') : '云端模式' }}
        </span>
      </div>
    </div>

    <div class="inspector-section">
      <h4 class="section-title">待审批</h4>
      <BashApprovalBar
        v-if="pendingBashApprovals.length > 0"
        :items="pendingBashApprovals"
        class="inspector-approval"
        @confirm="(requestId, approved) => $emit('bashConfirm', requestId, approved)"
      />
      <div v-else class="approval-empty">无待审批事项</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import TodoChecklist from './TodoChecklist.vue'
import type { TodoItem } from '../../types/chat'
import BashApprovalBar from '../chat/BashApprovalBar.vue'
import type { BashApprovalItem } from '../chat/BashApprovalBar.vue'

defineProps<{
  todos?: TodoItem[]
  workspace?: string
  executionMode?: string
  wsConnected?: boolean
  pendingBashApprovals?: BashApprovalItem[]
}>()

defineEmits<{
  bashConfirm: [requestId: string, approved: boolean]
}>()

</script>

<style scoped>
.task-inspector {
  width: var(--aw-inspector-width, 260px);
  flex-shrink: 0;
  border-left: 1px solid var(--aw-divider-soft);
  padding: 16px;
  overflow-y: auto;
  background: var(--aw-canvas);
}

.inspector-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.224px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Workspace */
.workspace-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.workspace-path {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-mode {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}

.mode-dot.connected { background: var(--aw-success); }
.mode-dot.disconnected { background: var(--aw-danger); }

/* Approval */
.inspector-approval {
  margin-top: 0;
}

.approval-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 4px 0;
}

/* Scrollbar */
.task-inspector::-webkit-scrollbar {
  width: 4px;
}

.task-inspector::-webkit-scrollbar-track {
  background: transparent;
}

.task-inspector::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

/* Dark mode */
[data-theme="dark"] .task-inspector {
  background: var(--aw-canvas);
  border-left-color: var(--aw-hairline);
}
</style>
