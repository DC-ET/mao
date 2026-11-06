<template>
  <!-- check_subagent / wait_subagents(超时分支) 的 background_subagents[] 进度行：
       #taskId + agentType + status 徽标 + 统计 + recentOutput 折叠区（默认单行省略）。 -->
  <div class="tool-subagent-progress">
    <div v-for="(row, i) in view" :key="row.taskId ?? i" class="progress-row">
      <div class="row-main">
        <span class="task-id">#{{ row.taskId ?? '?' }}</span>
        <span v-if="row.agentType" class="agent-type">{{ row.agentType }}</span>
        <span v-if="row.status" class="status-badge" :class="row.statusKind">{{ row.status }}</span>
      </div>
      <div v-if="row.stats" class="stats-line">{{ row.stats }}</div>
      <div v-if="row.recentOutput" class="recent-line">
        <span class="recent-text" :class="{ expanded: isExpanded(i) }">{{ row.recentOutput }}</span>
        <button class="recent-toggle" @click.stop="toggleExpand(i)">
          {{ isExpanded(i) ? '收起' : '展开' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { SubagentProgressRow } from '../../utils/toolRichView'

defineProps<{
  view: SubagentProgressRow[]
}>()

const expandedRows = ref(new Set<number>())

function isExpanded(index: number): boolean {
  return expandedRows.value.has(index)
}

function toggleExpand(index: number) {
  const next = new Set(expandedRows.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  expandedRows.value = next
}
</script>

<style scoped>
.tool-subagent-progress {
  margin-bottom: 8px;
}

.progress-row {
  padding: 5px 8px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
}

.progress-row + .progress-row {
  margin-top: 6px;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task-id {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  flex-shrink: 0;
}

.agent-type {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  font-weight: 600;
  line-height: 1.6;
}

/* running=primary / ok=成功绿 / fail=danger / muted=灰，底色用 color-mix 同 ApprovalStack 口径 */
.status-badge.running {
  color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 10%, transparent);
}

.status-badge.ok {
  color: var(--aw-success);
  background: color-mix(in srgb, var(--aw-success) 10%, transparent);
}

.status-badge.fail {
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 10%, transparent);
}

.status-badge.muted {
  color: var(--aw-ink-muted);
  background: color-mix(in srgb, var(--aw-ink-muted) 12%, transparent);
}

.stats-line {
  margin-top: 2px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.recent-line {
  margin-top: 2px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

/* 默认折叠为单行省略；展开态 160px 滚动 */
.recent-text {
  flex: 1;
  min-width: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-text-code);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-text.expanded {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.recent-toggle {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  padding: 0 2px;
  border-radius: var(--aw-radius-xs);
}

.recent-toggle:hover {
  background: var(--aw-primary-hover);
}
</style>
