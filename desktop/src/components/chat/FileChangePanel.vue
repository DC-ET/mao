<template>
  <div class="file-change-panel" v-if="changes.length > 0">
    <div class="file-change-header" @click="isExpanded = !isExpanded">
      <div class="file-change-info">
        <el-icon class="file-change-icon" :size="14"><Document /></el-icon>
        <span class="file-change-label">文件变更 ({{ changes.length }})</span>
      </div>
      <el-icon
        class="expand-icon"
        :class="{ expanded: isExpanded }"
      ><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="file-change-body">
      <div
        v-for="change in changes"
        :key="change.path"
        class="file-change-item"
      >
        <div class="file-path-row">
          <span class="file-type-badge" :class="change.type.toLowerCase()">
            {{ change.type === 'CREATED' ? '新建' : '修改' }}
          </span>
          <span class="file-path" :title="change.path">{{ change.path }}</span>
        </div>
        <div class="file-stats">
          <span v-if="change.linesAdded > 0" class="stat-added">+{{ change.linesAdded }}</span>
          <span v-if="change.linesDeleted > 0" class="stat-deleted">-{{ change.linesDeleted }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Document, ArrowDown } from '@element-plus/icons-vue'
import type { FileChange } from '../../types/chat'

const props = defineProps<{
  changes: FileChange[]
  mode?: 'realtime' | 'history'
}>()

const isExpanded = ref(true)
</script>

<style scoped>
.file-change-panel {
  margin: 8px 0;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.file-change-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--aw-canvas-parchment);
  transition: background 0.15s;
}

.file-change-header:hover {
  background: var(--aw-divider-soft);
}

.file-change-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.file-change-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.file-change-label {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  font-weight: 500;
}

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
  flex-shrink: 0;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.file-change-body {
  border-top: 1px solid var(--aw-divider-soft);
}

.file-change-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  gap: 12px;
}

.file-change-item:not(:last-child) {
  border-bottom: 1px solid var(--aw-divider-soft);
}

.file-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.file-type-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  flex-shrink: 0;
  line-height: 1.4;
}

.file-type-badge.created {
  color: #2d8a2d;
}

.file-type-badge.modified {
  color: #b87a00;
}

.file-path {
  font-size: 12px;
  color: var(--aw-ink);
  font-family: var(--aw-font-mono, 'SF Mono', Monaco, Consolas, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
  font-family: var(--aw-font-mono, 'SF Mono', Monaco, Consolas, monospace);
  font-weight: 500;
}

.stat-added {
  color: #2d8a2d;
}

.stat-deleted {
  color: #d94141;
}
</style>
