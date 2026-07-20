<template>
  <div class="file-change-panel" v-if="changes.length > 0">
    <div class="file-change-header" @click="toggleExpanded">
      <div class="file-change-info">
        <el-icon class="file-change-icon" :size="14"><Document /></el-icon>
        <span class="file-change-label">文件变更 ({{ mergedChanges.length }})</span>
      </div>
      <el-icon
        class="expand-icon"
        :class="{ expanded: isExpanded }"
      ><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="file-change-body">
      <div
        v-for="change in displayChanges"
        :key="change.path"
        class="file-change-item"
        @click="handleFileClick(change)"
      >
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
import { ref, computed, watch } from 'vue'
import { Document, ArrowDown } from '@element-plus/icons-vue'
import type { FileChange } from '../../types/chat'
import { useSessionStore } from '../../stores/session'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { toRelativeWorkspacePath } from '../../utils/workspace-path'

const props = defineProps<{
  changes: FileChange[]
  mode?: 'realtime' | 'history'
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId)
const { openDiffTab } = useCenterTabs(activeSessionIdRef)

type MergedChange = FileChange & { displayPath: string }

const mergedChanges = computed(() => {
  const byPath: Record<string, FileChange> = {}
  for (const c of props.changes) {
    const existing = byPath[c.path]
    if (existing) {
      existing.linesAdded += c.linesAdded
      existing.linesDeleted += c.linesDeleted
      if (c.type === 'CREATED') existing.type = 'CREATED'
      mergeDiff(existing, c)
    } else {
      byPath[c.path] = { ...c }
    }
  }
  const result: FileChange[] = []
  for (const path in byPath) {
    result.push(byPath[path])
  }
  return result
})

/**
 * ≤4 个文件默认展开，超过则默认折叠。
 * 必须 watch 数量变化：面板常在变更较少时挂载，后续追加文件时需重新套用默认策略；
 * 用户手动切换后不再覆盖。
 */
const userToggled = ref(false)
const isExpanded = ref(true)

watch(
  () => mergedChanges.value.length,
  (count) => {
    if (!userToggled.value) {
      isExpanded.value = count <= 4
    }
  },
  { immediate: true }
)

function toggleExpanded() {
  userToggled.value = true
  isExpanded.value = !isExpanded.value
}

const workspace = computed(() => sessionStore.activeSession?.workspace)

const displayChanges = computed((): MergedChange[] => {
  const ws = workspace.value
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

function mergeDiff(target: FileChange, incoming: FileChange) {
  if (!incoming.diffMode) return
  if (!target.diffMode) {
    target.diffMode = incoming.diffMode
    target.beforeContent = incoming.beforeContent
    target.afterContent = incoming.afterContent
    target.patchContent = incoming.patchContent
    target.patchTruncated = incoming.patchTruncated
    target.diffUnavailableReason = incoming.diffUnavailableReason
    return
  }

  if (target.diffMode === 'SNAPSHOT' && incoming.diffMode === 'SNAPSHOT') {
    target.afterContent = incoming.afterContent
    target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
    return
  }

  if (target.diffMode === 'PATCH' || incoming.diffMode === 'PATCH') {
    target.diffMode = 'PATCH'
    target.patchContent = [target.patchContent, incoming.patchContent].filter(Boolean).join('\n')
    target.beforeContent = undefined
    target.afterContent = undefined
    target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
    return
  }

  if (incoming.diffMode === 'UNSUPPORTED') {
    target.diffMode = 'UNSUPPORTED'
    target.diffUnavailableReason = incoming.diffUnavailableReason
  }
}

function handleFileClick(change: MergedChange) {
  const session = sessionStore.activeSession
  if (!session) return

  const canOpen = session.executionMode === 'CLOUD'
    ? !!sessionStore.activeSessionId
    : !!session.workspace
  if (!canOpen) return

  const title = change.displayPath.split(/[/\\]/).pop() || change.displayPath
  openDiffTab({ ...change, path: change.displayPath }, `${title} (变更)`)
}
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
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
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
  cursor: pointer;
  transition: background 0.15s;
}

.file-change-item:hover {
  background: var(--aw-canvas-parchment);
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
  color: var(--aw-success);
}

.file-type-badge.modified {
  color: var(--aw-warning);
}

.file-type-badge.deleted {
  color: var(--aw-danger);
}

.file-type-badge.renamed {
  color: var(--aw-primary);
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
  color: var(--aw-success);
}

.stat-deleted {
  color: var(--aw-danger);
}
</style>
