<template>
  <div class="task-inspector" :style="panelStyle">
    <div class="resize-handle" @mousedown="onResizeStart"></div>
    <div class="inspector-section">
      <h4 class="section-title">进度</h4>
      <TodoChecklist :todos="todos" />
    </div>

    <div class="inspector-section">
      <h4 class="section-title">待审批</h4>
      <BashApprovalBar
        v-if="pendingBashApprovals && pendingBashApprovals.length > 0"
        :items="pendingBashApprovals"
        class="inspector-approval"
        @confirm="(requestId, approved) => $emit('bashConfirm', requestId, approved)"
      />
      <div v-else class="approval-empty">无待审批事项</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
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

// Panel resize
const panelWidth = ref<number | null>(null)
const MIN_WIDTH = 200
const MAX_WIDTH = 500

const panelStyle = computed(() => {
  if (panelWidth.value !== null) {
    return { width: `${panelWidth.value}px` }
  }
  return {}
})

function onResizeStart(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = panelWidth.value ?? 260

  function onMouseMove(ev: MouseEvent) {
    // Drag left → wider, drag right → narrower
    const newWidth = startWidth - (ev.clientX - startX)
    panelWidth.value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

</script>

<style scoped>
.task-inspector {
  position: relative;
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

/* Resize handle */
.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle:active {
  background: var(--aw-primary);
  opacity: 0.3;
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
