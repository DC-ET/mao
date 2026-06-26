<template>
  <div class="file-tree-node">
    <div
      class="node-row"
      :class="{ 'is-directory': node.isDirectory, 'is-symlink': node.isSymlink, 'is-expanded': node.expanded }"
      :style="{ paddingLeft: depth * 16 + 'px' }"
      @click="handleClick"
    >
      <el-icon v-if="node.isDirectory" class="node-expand-icon">
        <ArrowDown v-if="node.expanded && !node.isSymlink" />
        <ArrowRight v-else />
      </el-icon>
      <span v-else class="node-expand-icon-placeholder"></span>

      <el-icon class="node-icon">
        <FolderOpened v-if="node.isDirectory && node.expanded && !node.isSymlink" />
        <Folder v-else-if="node.isDirectory" />
        <Link v-else-if="node.isSymlink" />
        <Picture v-else-if="isImage" />
        <Document v-else />
      </el-icon>

      <span class="node-name" :class="{ 'large-file': isLargeFile }">{{ node.name }}</span>
      <span v-if="isLargeFile" class="large-badge">大文件</span>
    </div>

    <div v-if="node.error" class="node-error">
      <span>{{ node.error }}</span>
      <button class="retry-btn" @click.stop="$emit('retry', node)">重试</button>
    </div>

    <template v-if="node.expanded && node.children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :workspace="workspace"
        @open-file="$emit('open-file', $event)"
        @toggle-dir="$emit('toggle-dir', $event)"
        @retry="$emit('retry', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Folder, FolderOpened, Document, Picture, ArrowRight, ArrowDown, Link } from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'

const props = defineProps<{
  node: FileNode
  depth: number
  workspace: string
}>()

const emit = defineEmits<{
  'open-file': [payload: { absolutePath: string; title: string }]
  'toggle-dir': [node: FileNode]
  'retry': [node: FileNode]
}>()

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])

const isImage = computed(() => {
  const ext = getExtension(props.node.name)
  return IMAGE_EXTENSIONS.has(ext)
})

const isLargeFile = computed(() => {
  return !props.node.isDirectory && (props.node.size ?? 0) > 1024 * 1024
})

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function handleClick() {
  if (props.node.isSymlink) return
  if (props.node.isDirectory) {
    emit('toggle-dir', props.node)
  } else {
    const sep = props.workspace.includes('\\') ? '\\' : '/'
    const absolutePath = props.workspace.replace(/[\\/]+$/, '') + sep + props.node.path
    emit('open-file', { absolutePath, title: props.node.name })
  }
}
</script>

<style scoped>
.node-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  cursor: pointer;
  user-select: none;
  border-radius: var(--aw-radius-xs);
  transition: background 0.1s;
  min-height: 26px;
}

.node-row:hover {
  background: var(--aw-canvas-parchment);
}

.node-row.is-symlink {
  opacity: 0.5;
  cursor: default;
}

.node-expand-icon {
  font-size: 12px;
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.node-expand-icon-placeholder {
  width: 14px;
  flex-shrink: 0;
}

.node-icon {
  font-size: 14px;
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.node-row.is-directory .node-icon {
  color: var(--aw-primary);
}

.node-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.node-name.large-file {
  color: var(--aw-ink-muted-48);
}

.large-badge {
  font-size: 10px;
  color: #b37400;
  background: rgba(179, 116, 0, 0.08);
  padding: 1px 5px;
  border-radius: var(--aw-radius-xs);
  flex-shrink: 0;
}

.node-error {
  padding: 4px 8px 4px 38px;
  font-size: var(--aw-text-fine);
  color: var(--aw-danger);
  display: flex;
  align-items: center;
  gap: 8px;
}

.retry-btn {
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 1px 8px;
  cursor: pointer;
}

.retry-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

/* Dark mode */
[data-theme="dark"] .node-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
