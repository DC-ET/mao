<template>
  <div class="fm-list">
    <div class="fm-list-head">
      <div class="fm-col fm-col-name" @click="$emit('sort', 'name')">
        <span>名称</span>
        <el-icon v-if="sortBy === 'name'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
      </div>
      <div class="fm-col fm-col-size" @click="$emit('sort', 'size')">
        <span>大小</span>
        <el-icon v-if="sortBy === 'size'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
      </div>
      <div class="fm-col fm-col-mtime" @click="$emit('sort', 'mtime')">
        <span>修改时间</span>
        <el-icon v-if="sortBy === 'mtime'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
      </div>
    </div>
    <div
      v-for="entry in entries"
      :key="entry.path"
      class="fm-list-row"
      :class="{
        selected: isSelected(entry.path),
        'is-drop-target': dropTargetPath === entry.path,
      }"
      draggable="true"
      @dragstart="onDragstart(entry, $event)"
      @dragover="onDragOver(entry, $event)"
      @dragleave="$emit('folder-dragleave')"
      @drop="onDrop(entry, $event)"
      @click="onClick(entry, $event)"
      @dblclick="$emit('open', entry)"
      @contextmenu.prevent.stop="$emit('contextmenu', { entry, x: $event.clientX, y: $event.clientY })"
    >
      <div class="fm-col fm-col-name">
        <el-icon class="fm-row-icon" :class="`is-${iconKind(entry)}`">
          <FolderOpened v-if="iconKind(entry) === 'folder'" />
          <Link v-else-if="iconKind(entry) === 'link'" />
          <Picture v-else-if="iconKind(entry) === 'image'" />
          <Document v-else />
        </el-icon>
        <input
          v-if="renamingPath === entry.path"
          :ref="setRenameInput"
          class="fm-row-rename"
          :value="entry.name"
          @click.stop
          @input="renameDone = false"
          @keydown.enter.stop="commitRename(($event.target as HTMLInputElement).value)"
          @keydown.esc.stop="$emit('cancel-edit')"
          @blur="commitRename(($event.target as HTMLInputElement).value)"
        />
        <span v-else class="fm-row-name" :title="entry.name">{{ entry.name }}</span>
      </div>
      <div class="fm-col fm-col-size">{{ entry.isDirectory ? '—' : formatSize(entry.size) }}</div>
      <div class="fm-col fm-col-mtime">{{ formatTime(entry.mtime) }}</div>
    </div>
    <div v-if="creating" class="fm-list-row is-creating">
      <div class="fm-col fm-col-name">
        <el-icon class="fm-row-icon">
          <Document v-if="creating.kind === 'file'" />
          <FolderAdd v-else />
        </el-icon>
        <input
          ref="createInput"
          class="fm-row-rename"
          placeholder="名称"
          @click.stop
          @input="createDone = false"
          @keydown.enter.stop="commitCreate(($event.target as HTMLInputElement).value)"
          @keydown.esc.stop="$emit('cancel-edit')"
          @blur="commitCreate(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="fm-col fm-col-size">—</div>
      <div class="fm-col fm-col-mtime">新建{{ creating.kind === 'dir' ? '文件夹' : '文件' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { CaretBottom, CaretTop, Document, FolderAdd, FolderOpened, Link, Picture } from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'
import { DRAG_PATHS_MIME, effectiveDragSources, formatSize, formatTime, iconKindOf } from '../../utils/file-manager'

const props = defineProps<{
  entries: FileNode[]
  selectedPaths: string[]
  renamingPath: string
  creating: { dir: string; kind: 'file' | 'dir' } | null
  dropTargetPath: string
  sortBy: 'name' | 'size' | 'mtime'
  sortOrder: 'asc' | 'desc'
}>()

const emit = defineEmits<{
  open: [entry: FileNode]
  contextmenu: [payload: { entry: FileNode | null; x: number; y: number }]
  'toggle-select': [entry: FileNode, mods: { meta: boolean; shift: boolean }]
  'commit-rename': [path: string, name: string]
  'commit-create': [name: string]
  'cancel-edit': []
  'item-dragstart': [entry: FileNode, event: DragEvent]
  'folder-dragover': [path: string]
  'folder-dragleave': []
  'folder-drop': [entry: FileNode, event: DragEvent]
  sort: [field: 'name' | 'size' | 'mtime']
}>()

const renameInput = ref<HTMLInputElement | null>(null)
const createInput = ref<HTMLInputElement>()
const renameDone = ref(false)
const createDone = ref(false)

function setRenameInput(el: unknown) {
  renameInput.value = el as HTMLInputElement | null
}

watch(() => props.renamingPath, async (path) => {
  if (!path) return
  renameDone.value = false
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
})

watch(() => props.creating, async (draft) => {
  if (!draft) return
  createDone.value = false
  await nextTick()
  createInput.value?.focus()
})

function iconKind(entry: FileNode): string {
  return iconKindOf(entry.name, entry.isDirectory, entry.isSymlink)
}

function isSelected(path: string): boolean {
  return props.selectedPaths.includes(path)
}

function onClick(entry: FileNode, e: MouseEvent) {
  emit('toggle-select', entry, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })
}

function onDragstart(entry: FileNode, e: DragEvent) {
  if (!e.dataTransfer) return
  const sources = effectiveDragSources(entry.path, props.selectedPaths)
  e.dataTransfer.setData(DRAG_PATHS_MIME, JSON.stringify(sources))
  e.dataTransfer.effectAllowed = 'move'
  emit('item-dragstart', entry, e)
}

function onDragOver(entry: FileNode, e: DragEvent) {
  if (!entry.isDirectory || entry.isSymlink) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  emit('folder-dragover', entry.path)
}

function onDrop(entry: FileNode, e: DragEvent) {
  if (!entry.isDirectory || entry.isSymlink) return
  emit('folder-drop', entry, e)
}

function commitRename(value: string) {
  if (renameDone.value) return
  renameDone.value = true
  emit('commit-rename', props.renamingPath, value.trim())
}

function commitCreate(value: string) {
  if (createDone.value) return
  createDone.value = true
  emit('commit-create', value.trim())
}
</script>

<style scoped>
.fm-list {
  display: flex;
  flex-direction: column;
  padding: 4px 0 12px;
}

.fm-list-head,
.fm-list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
}

.fm-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 30px;
  font-size: var(--aw-text-fine, 11px);
  color: var(--aw-ink-muted-48, #999);
  background: var(--aw-surface, #fff);
  border-bottom: 1px solid var(--aw-divider-soft, #e0e0e0);
}

.fm-list-head .fm-col {
  cursor: pointer;
  user-select: none;
}

.fm-list-head .fm-col:hover {
  color: var(--aw-ink, #1a1a1a);
}

.fm-list-row {
  height: 32px;
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
  cursor: default;
  user-select: none;
}

.fm-list-row:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
}

.fm-list-row.selected {
  background: color-mix(in srgb, var(--aw-primary, #0066cc) 10%, transparent);
}

.fm-list-row.is-drop-target {
  outline: 1px dashed var(--aw-primary, #0066cc);
  outline-offset: -1px;
}

.fm-col {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fm-col-name {
  flex: 1;
}

.fm-col-size {
  width: 88px;
  justify-content: flex-end;
  color: var(--aw-ink-muted, #666);
}

.fm-col-mtime {
  width: 136px;
  justify-content: flex-end;
  color: var(--aw-ink-muted, #666);
}

.fm-sort-flag {
  font-size: 10px;
}

.fm-row-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--aw-ink-muted, #666);
}

.fm-row-icon.is-folder {
  color: var(--aw-primary, #0066cc);
}

.fm-row-icon.is-image {
  color: #7c5cbf;
}

.fm-row-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-row-rename {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-primary, #0066cc);
  border-radius: var(--aw-radius-xs, 4px);
}

[data-theme="dark"] .fm-list-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .fm-list-head {
  background: var(--aw-surface, #2a2a2a);
}
</style>
