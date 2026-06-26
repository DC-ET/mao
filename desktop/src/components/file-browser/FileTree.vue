<template>
  <div class="file-tree">
    <div v-if="!workspace" class="file-tree-empty">
      <p>请先选择工作区目录</p>
    </div>
    <div v-else class="file-tree-content" v-loading="loading">
      <div v-if="treeData.length === 0 && !loading" class="file-tree-empty">
        <p>空目录</p>
      </div>
      <FileTreeNode
        v-for="node in treeData"
        :key="node.path"
        :node="node"
        :depth="0"
        :workspace="workspace"
        @open-file="handleOpenFile"
        @toggle-dir="handleToggleDir"
        @retry="handleRetry"
      />
    </div>
    <div class="file-tree-footer">
      <button class="refresh-btn" @click="handleRefresh" :disabled="!workspace || loading">
        <el-icon><Refresh /></el-icon>
        <span>刷新</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { useFileBrowser } from '../../composables/useFileBrowser'
import FileTreeNode from './FileTreeNode.vue'
import type { FileNode } from '../../types/file-browser'

const props = defineProps<{
  workspace: string
}>()

const emit = defineEmits<{
  'open-file': [payload: { absolutePath: string; title: string }]
}>()

const workspaceRef = toRef(props, 'workspace')
const { treeData, loading, expandDir, refresh } = useFileBrowser(workspaceRef)

function handleOpenFile(payload: { absolutePath: string; title: string }) {
  emit('open-file', payload)
}

function handleToggleDir(node: FileNode) {
  expandDir(node)
}

function handleRetry(node: FileNode) {
  node.error = undefined
  node.children = undefined
  expandDir(node)
}

function handleRefresh() {
  refresh()
}
</script>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.file-tree-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.file-tree-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.file-tree-empty p {
  margin: 0;
}

.file-tree-footer {
  padding: 8px;
  border-top: 1px solid var(--aw-divider-soft);
  display: flex;
  justify-content: center;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 12px;
  border-radius: var(--aw-radius-xs);
  transition: color 0.15s, background 0.15s;
}

.refresh-btn:hover:not(:disabled) {
  color: var(--aw-ink);
  background: var(--aw-canvas-parchment);
}

.refresh-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Scrollbar */
.file-tree-content::-webkit-scrollbar {
  width: 4px;
}

.file-tree-content::-webkit-scrollbar-track {
  background: transparent;
}

.file-tree-content::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

/* Dark mode */
[data-theme="dark"] .file-tree-footer {
  border-top-color: var(--aw-hairline);
}

[data-theme="dark"] .refresh-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
