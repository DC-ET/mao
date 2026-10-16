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
          <span
            v-if="change.relativePath != null"
            class="file-path file-path-clickable"
            role="button"
            tabindex="0"
            :title="`${change.path}（点击预览当前内容）`"
            @click="onPathClick(change)"
            @keydown.enter="onPathClick(change)"
          >{{ change.displayPath }}</span>
          <span v-else class="file-path" :title="change.path">{{ change.displayPath }}</span>
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
import { ElMessage } from 'element-plus'
import { Document, ArrowDown } from '@element-plus/icons-vue'
import type { FileChange } from '../types/chat'
import { toRelativeWorkspacePath } from '../../../utils/workspace-path'

const props = defineProps<{ changes: FileChange[]; workspace?: string }>()

const emit = defineEmits<{
  /** 点击文件路径：透出工作区内相对路径，由详情页打开预览 */
  (e: 'preview', relativePath: string): void
}>()

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
  return mergedChanges.value.map(c => {
    // 相对化失败（路径不在会话工作区内，函数原样返回绝对路径）时该行不可点
    const relativePath = ws ? toRelativeWorkspacePath(ws, c.path) : c.path
    const inWorkspace = relativePath !== c.path || !isAbsoluteLike(relativePath)
    return {
      ...c,
      displayPath: ws ? relativePath : c.path,
      relativePath: inWorkspace ? relativePath : null,
    }
  })
})

/** 绝对路径（Unix / Windows 盘符）判定：相对化结果仍是绝对路径即视为工作区外 */
function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith('/')
}

function onPathClick(change: { path: string; relativePath: string | null }) {
  if (change.relativePath == null) {
    ElMessage.warning('文件不在会话工作区内，无法预览')
    return
  }
  emit('preview', change.relativePath)
}

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
  color: var(--mao-success);
}

.file-type-badge.modified {
  color: var(--mao-warn);
}

.file-type-badge.deleted {
  color: var(--mao-danger);
}

.file-type-badge.renamed {
  color: var(--mao-renamed);
}

.file-path {
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 可点击路径：点击打开工作区文件预览（样式与 drill-link 一致） */
.file-path-clickable {
  color: var(--el-color-primary);
  cursor: pointer;
}

.file-path-clickable:hover {
  text-decoration: underline;
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
  color: var(--mao-success);
}

.stat-deleted {
  color: var(--mao-danger);
}
</style>
