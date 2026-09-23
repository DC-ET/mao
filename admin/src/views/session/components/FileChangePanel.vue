<template>
  <div class="file-change-panel" v-if="changes.length > 0">
    <div class="file-change-header" @click="toggleExpanded">
      <div class="file-change-info">
        <el-icon class="file-change-icon" :size="14"><Document /></el-icon>
        <span class="file-change-label">文件变更 ({{ mergedChanges.length }})</span>
      </div>
      <el-icon class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="file-change-body">
      <div v-for="change in displayChanges" :key="change.path" class="file-change-item">
        <div class="file-path-row">
          <span class="file-type-badge" :class="changeTypeClass(change.type)">
            {{ changeTypeLabel(change.type) }}
          </span>
          <span class="file-path" :title="change.path">{{ change.displayPath }}</span>
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
import { computed, ref, watch } from 'vue'
import { Document, ArrowDown } from '@element-plus/icons-vue'
import type { FileChange } from '../types/chat'
import { toRelativeWorkspacePath } from '../../../utils/workspace-path'

const props = defineProps<{ changes: FileChange[]; workspace?: string }>()

/** 同一路径多次写入合并成一行，和客户端文件变更面板一致。 */
const mergedChanges = computed(() => {
  const byPath = new Map<string, FileChange>()
  for (const change of props.changes) {
    const linesAdded = Number(change.linesAdded) || 0
    const linesDeleted = Number(change.linesDeleted) || 0
    const existing = byPath.get(change.path)
    if (!existing) {
      byPath.set(change.path, { ...change, linesAdded, linesDeleted })
      continue
    }
    existing.linesAdded += linesAdded
    existing.linesDeleted += linesDeleted
    if ((change.type || '').toUpperCase() === 'CREATED') existing.type = 'CREATED'
  }
  return [...byPath.values()]
})

const userToggled = ref(false)
const isExpanded = ref(true)

watch(
  () => mergedChanges.value.length,
  (count) => {
    if (!userToggled.value) isExpanded.value = count <= 4
  },
  { immediate: true }
)

function toggleExpanded() {
  userToggled.value = true
  isExpanded.value = !isExpanded.value
}

const displayChanges = computed(() => {
  const ws = props.workspace
  return mergedChanges.value.map(c => ({
    ...c,
    displayPath: ws ? toRelativeWorkspacePath(ws, c.path) : c.path
  }))
})

function changeTypeLabel(type: string): string {
  switch ((type || '').toUpperCase()) {
    case 'CREATED': return '新建'
    case 'MODIFIED': return '修改'
    case 'DELETED': return '删除'
    case 'RENAMED': return '重命名'
    case 'COPIED': return '复制'
    default: return type || '变更'
  }
}

function changeTypeClass(type: string): string {
  switch ((type || '').toUpperCase()) {
    case 'CREATED': return 'created'
    case 'DELETED': return 'deleted'
    case 'RENAMED':
    case 'COPIED': return 'renamed'
    default: return 'modified'
  }
}
</script>

<style scoped>
.file-change-panel {
  margin: 8px 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}

.file-change-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--el-fill-color-light);
  transition: background 0.15s;
}

.file-change-header:hover {
  background: var(--el-fill-color);
}

.file-change-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.file-change-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.file-change-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.expand-icon {
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
  font-size: 12px;
  flex-shrink: 0;
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.file-change-body {
  border-top: 1px solid var(--el-border-color-lighter);
}

.file-change-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  gap: 12px;
}

.file-change-item:not(:last-child) {
  border-bottom: 1px solid var(--el-border-color-lighter);
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

.file-type-badge.deleted {
  color: #d94141;
}

.file-type-badge.renamed {
  color: #6b46c1;
}

.file-path {
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 500;
}

.stat-added {
  color: #2d8a2d;
}

.stat-deleted {
  color: #d94141;
}
</style>
