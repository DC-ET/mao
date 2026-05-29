<template>
  <div class="task-inspector">
    <div class="inspector-section">
      <h4 class="section-title">进度</h4>
      <TodoChecklist :todos="todos" />
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
