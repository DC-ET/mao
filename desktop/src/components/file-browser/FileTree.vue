<template>
  <div class="file-tree">
    <div v-if="!workspace" class="file-tree-empty">
      <p>请先选择工作区目录</p>
    </div>
    <template v-else>
      <div class="file-tree-toolbar">
        <el-input
          v-model="filterText"
          placeholder="筛选文件..."
          clearable
          :prefix-icon="Search"
        />
        <el-icon class="toolbar-refresh" :class="{ 'is-disabled': loading }" @click="handleRefresh"><Refresh /></el-icon>
      </div>
      <div class="file-tree-content" v-loading="loading">
        <div v-if="filteredTreeData.length === 0 && !loading" class="file-tree-empty">
          <p>{{ filterText ? '无匹配文件' : '空目录' }}</p>
        </div>
        <FileTreeNode
          v-for="node in filteredTreeData"
          :key="node.path"
          :node="node"
          :depth="0"
          :workspace="workspace"
          @open-file="handleOpenFile"
          @toggle-dir="handleToggleDir"
          @retry="handleRetry"
          @node-contextmenu="handleNodeContextmenu"
        />
      </div>
    </template>

    <FileTreeContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      @hide="ctxMenu.visible = false"
      @copy-absolute="handleCopyAbsolute"
      @copy-relative="handleCopyRelative"
      @open-in-finder="handleOpenInFinder"
      @add-to-chat="handleAddToChat"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, toRef, watch } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { useFileBrowser } from '../../composables/useFileBrowser'
import FileTreeNode from './FileTreeNode.vue'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import type { FileNode } from '../../types/file-browser'

const props = defineProps<{
  workspace: string
}>()

const emit = defineEmits<{
  'open-file': [payload: { absolutePath: string; title: string }]
  'add-file-to-chat': [filePath: string]
}>()

const workspaceRef = toRef(props, 'workspace')
const { treeData, loading, expandDir, refresh, loadAllDirectories } = useFileBrowser(workspaceRef)

const filterText = ref('')

// Context menu state
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  node: null as FileNode | null,
})

function handleNodeContextmenu(payload: { node: FileNode; x: number; y: number }) {
  ctxMenu.x = payload.x
  ctxMenu.y = payload.y
  ctxMenu.node = payload.node
  ctxMenu.visible = true
}

function getAbsolutePath(nodePath: string): string {
  if (!props.workspace) return nodePath
  const sep = props.workspace.includes('\\') ? '\\' : '/'
  return props.workspace.replace(/[\\/]+$/, '') + sep + nodePath
}

function handleCopyAbsolute() {
  if (!ctxMenu.node) return
  navigator.clipboard.writeText(getAbsolutePath(ctxMenu.node.path))
}

function handleCopyRelative() {
  if (!ctxMenu.node) return
  navigator.clipboard.writeText(ctxMenu.node.path)
}

function handleOpenInFinder() {
  if (!ctxMenu.node) return
  const absPath = getAbsolutePath(ctxMenu.node.path)
  window.electronAPI.showItemInFolder(absPath)
}

function handleAddToChat() {
  if (!ctxMenu.node) return
  const absPath = getAbsolutePath(ctxMenu.node.path)
  emit('add-file-to-chat', absPath)
}

let filterSeq = 0
watch(filterText, async (val) => {
  const keyword = val.trim()
  if (!keyword) return
  const seq = ++filterSeq
  await loadAllDirectories(treeData.value, 0, 6)
  if (seq !== filterSeq) return
  filterVersion.value++
})

const filterVersion = ref(0)

function filterNodes(nodes: FileNode[], keyword: string): FileNode[] {
  const lower = keyword.toLowerCase()
  const result: FileNode[] = []
  for (const node of nodes) {
    if (node.isDirectory) {
      const filteredChildren = node.children ? filterNodes(node.children, keyword) : []
      if (node.name.toLowerCase().includes(lower) || filteredChildren.length > 0) {
        result.push({ ...node, children: node.children ? filteredChildren : node.children, expanded: filteredChildren.length > 0 ? true : node.expanded })
      }
    } else {
      if (node.name.toLowerCase().includes(lower)) {
        result.push(node)
      }
    }
  }
  return result
}

const filteredTreeData = computed(() => {
  // Depend on filterVersion to re-evaluate after async load
  void filterVersion.value
  const keyword = filterText.value.trim()
  if (!keyword) return treeData.value
  return filterNodes(treeData.value, keyword)
})

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
  if (loading.value) return
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

.file-tree-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 4px 8px;
  
}

.file-tree-toolbar :deep(.el-input) {
  flex: 1;
  font-size: 14px;
}

.toolbar-refresh {
  flex-shrink: 0;
  font-size: 28px;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--aw-radius-xs);
  transition: color 0.15s, background 0.15s;
}

.toolbar-refresh:hover:not(.is-disabled) {
  color: var(--aw-ink);
  background: var(--aw-canvas-parchment);
}

.toolbar-refresh.is-disabled {
  opacity: 0.4;
  cursor: default;
}

.file-tree-content {
  flex: 1;
  overflow-y: auto;
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
[data-theme="dark"] .toolbar-refresh:hover:not(.is-disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
