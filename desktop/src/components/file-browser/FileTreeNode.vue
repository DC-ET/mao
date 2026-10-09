<template>
  <div class="file-tree-node">
    <div
      class="node-row"
      :class="{ 'is-directory': node.isDirectory, 'is-symlink': node.isSymlink, 'is-expanded': node.expanded, 'is-selected': selected, 'is-drop': dropActive }"
      :style="{ paddingLeft: depth * 14 + 8 + 'px' }"
      :title="node.path || node.name"
      :draggable="canDrag"
      @click="handleClick"
      @contextmenu.prevent.stop="$emit('node-contextmenu', { node, x: $event.clientX, y: $event.clientY })"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @drop.prevent.stop="onDrop"
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

      <input
        v-if="renaming"
        ref="nameInput"
        class="node-name-input"
        :value="draftName"
        @click.stop
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
        @input="draftName = ($event.target as HTMLInputElement).value"
      />
      <span v-else class="node-name" :class="{ 'large-file': isLargeFile }">{{ node.name }}</span>
      <span v-if="isLargeFile" class="large-badge">大文件</span>
    </div>

    <div v-if="node.error" class="node-error">
      <span>{{ node.error }}</span>
      <button class="retry-btn" @click.stop="$emit('retry', node)">重试</button>
    </div>

    <div
      v-if="creating"
      class="node-row"
      :style="{ paddingLeft: (depth + 1) * 14 + 8 + 'px' }"
    >
      <input
        ref="createInput"
        class="node-name-input"
        :value="draftName"
        placeholder="名称"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
        @input="draftName = ($event.target as HTMLInputElement).value"
      />
    </div>
    <template v-if="node.expanded && node.children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @open-file="$emit('open-file', $event)"
        @toggle-dir="$emit('toggle-dir', $event)"
        @retry="$emit('retry', $event)"
        @node-contextmenu="$emit('node-contextmenu', $event)"
        @toggle-select="$emit('toggle-select', $event)"
        @drag-hover="$emit('drag-hover', $event)"
        @node-drop="$emit('node-drop', $event)"
        @external-drop="$emit('external-drop', $event)"
        @commit-name="$emit('commit-name', $event)"
        @cancel-edit="$emit('cancel-edit')"
        :can-write="canWrite"
        :selected-paths="selectedPaths"
        :drop-path="dropPath"
        :rename-path="renamePath"
        :create-path="createPath"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Folder, FolderOpened, Document, Picture, ArrowRight, ArrowDown, Link } from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'

const props = defineProps<{
  node: FileNode
  depth: number
  canWrite?: boolean
  selectedPaths?: string[]
  dropPath?: string
  renamePath?: string
  createPath?: string | null
}>()

const emit = defineEmits<{
  'open-file': [payload: { path: string; title: string }]
  'toggle-dir': [node: FileNode]
  'retry': [node: FileNode]
  'node-contextmenu': [payload: { node: FileNode; x: number; y: number }]
  'toggle-select': [path: string]
  'drag-hover': [path: string]
  'node-drop': [payload: { target: FileNode; paths: string[] }]
  'external-drop': [payload: { target: FileNode; data: DataTransfer }]
  'commit-name': [name: string]
  'cancel-edit': []
}>()

const selected = computed(() => props.selectedPaths?.includes(props.node.path) ?? false)
const dropActive = computed(() => !!props.canWrite && props.dropPath === props.node.path && !!props.node.isDirectory)
const renaming = computed(() => props.renamePath === props.node.path)
const creating = computed(() => props.createPath === props.node.path)
const canDrag = computed(() => !!props.canWrite && !props.node.isSymlink && !renaming.value)
const draftName = ref('')
const editClosed = ref(false)
const nameInput = ref<HTMLInputElement>()
const createInput = ref<HTMLInputElement>()

watch([renaming, creating], ([isRename, isCreate]) => {
  if (!isRename && !isCreate) return
  editClosed.value = false
  const base = props.node.path.includes('/')
    ? props.node.path.slice(props.node.path.lastIndexOf('/') + 1)
    : props.node.path
  draftName.value = isRename ? (base || props.node.name) : ''
  void nextTick(() => (isRename ? nameInput.value : createInput.value)?.focus())
}, { immediate: true })

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

function finishEdit(name: string | null) {
  if (editClosed.value) return
  editClosed.value = true
  if (name == null) emit('cancel-edit')
  else emit('commit-name', name)
}

function commit() {
  finishEdit(draftName.value)
}

function cancel() {
  finishEdit(null)
}

function handleClick(event: MouseEvent) {
  if (renaming.value) return
  if ((event.metaKey || event.ctrlKey) && props.canWrite && !props.node.isSymlink) {
    emit('toggle-select', props.node.path)
    return
  }
  if (props.node.isSymlink) return
  if (props.node.isDirectory) {
    emit('toggle-dir', props.node)
  } else {
    emit('open-file', { path: props.node.path, title: props.node.name })
  }
}

function onDragStart(event: DragEvent) {
  const paths = selected.value && (props.selectedPaths?.length ?? 0) > 1 ? props.selectedPaths! : [props.node.path]
  event.dataTransfer?.setData('application/x-mao-paths', JSON.stringify(paths))
  event.dataTransfer?.setData('text/plain', props.node.path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent) {
  if (!props.canWrite || !props.node.isDirectory || props.node.isSymlink) return
  event.preventDefault()
  emit('drag-hover', props.node.path)
}

function onDrop(event: DragEvent) {
  if (!props.canWrite || !props.node.isDirectory || props.node.isSymlink) return
  const raw = event.dataTransfer?.getData('application/x-mao-paths')
  if (raw) {
    try {
      const paths = JSON.parse(raw) as string[]
      if (paths.length > 0) {
        emit('node-drop', { target: props.node, paths })
        return
      }
    } catch {
      // 不是树内拖拽
    }
  }
  if (event.dataTransfer) emit('external-drop', { target: props.node, data: event.dataTransfer })
}
</script>

<style scoped>
.node-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 0;
  cursor: pointer;
  user-select: none;
  border-radius: var(--aw-radius-xs);
  transition: background 0.1s;
  min-height: 26px;
  white-space: nowrap;
}

.node-row:hover {
  background: var(--aw-canvas-parchment);
}

.node-row.is-selected {
  background: var(--aw-primary-hover, rgba(0, 102, 204, 0.12));
}

.node-row.is-drop {
  outline: 1px dashed var(--aw-primary);
}

.node-name-input {
  flex: 1;
  min-width: 80px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 0 4px;
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
  flex-shrink: 0;
}

.node-name.large-file {
  color: var(--aw-ink-muted-48);
}

.large-badge {
  font-size: 10px;
  color: var(--aw-status-waiting);
  background: var(--aw-status-waiting-bg);
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
  white-space: nowrap;
}

.retry-btn {
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 1px 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.retry-btn:hover {
  background: var(--aw-primary-hover);
}

/* Dark mode */
[data-theme="dark"] .node-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
