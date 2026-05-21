<template>
  <div class="task-inspector">
    <div class="inspector-section">
      <h4 class="section-title">进度</h4>
      <ProgressChecklist :steps="steps" />
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

    <div v-if="activities.length > 0" class="inspector-section">
      <h4 class="section-title">最近活动</h4>
      <div class="activity-list">
        <div v-for="act in activities.slice(0, 10)" :key="act.id" class="activity-item">
          <span class="activity-type-badge" :class="`type-${act.type}`">{{ typeLabel(act.type) }}</span>
          <span class="activity-text">{{ act.summary }}</span>
        </div>
      </div>
    </div>

    <div class="inspector-section">
      <h4 class="section-title">待审批</h4>
      <BashApprovalBar
        v-if="pendingBashCommand"
        :command="pendingBashCommand"
        class="inspector-approval"
        @confirm="$emit('bashConfirm', $event)"
      />
      <div v-else class="approval-empty">无待审批事项</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ProgressChecklist from './ProgressChecklist.vue'
import BashApprovalBar from '../chat/BashApprovalBar.vue'

defineProps<{
  steps?: Array<{ id: string; label: string; done: boolean }>
  workspace?: string
  executionMode?: string
  wsConnected?: boolean
  pendingBashCommand?: string
  activities: Array<{
    id?: number
    type: string
    target?: string
    summary: string
    status?: string
  }>
}>()

defineEmits<{
  bashConfirm: [approved: boolean]
}>()

function typeLabel(type: string) {
  switch (type) {
    case 'READ': return '读'
    case 'EDIT': return '改'
    case 'RUN': return '跑'
    case 'EXPLORE': return '查'
    default: return '做'
  }
}
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

/* Activity */
.activity-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-caption);
}

.activity-type-badge {
  font-size: var(--aw-text-micro);
  padding: 1px 6px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-pearl);
  color: var(--aw-ink-muted-80);
  flex-shrink: 0;
  letter-spacing: 0.5px;
}

.activity-text {
  color: var(--aw-ink-muted-80);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
