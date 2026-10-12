<template>
  <div class="fm-grid">
    <div
      v-for="entry in entries"
      :key="entry.path"
      class="fm-grid-cell"
      :class="{
        selected: isSelected(entry.path),
        'is-drop-target': dropTargetPath === entry.path,
        'is-symlink': entry.isSymlink,
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
      <span v-if="isSelected(entry.path)" class="fm-grid-check"><el-icon><Check /></el-icon></span>
      <el-icon class="fm-grid-icon" :class="`is-${iconKind(entry)}`">
        <FolderOpened v-if="iconKind(entry) === 'folder'" />
        <Link v-else-if="iconKind(entry) === 'link'" />
        <Picture v-else-if="iconKind(entry) === 'image'" />
        <Document v-else />
      </el-icon>
      <input
        v-if="renamingPath === entry.path"
        :ref="setRenameInput"
        class="fm-grid-rename"
        :value="entry.name"
        @click.stop
        @input="renameDone = false"
        @keydown.enter.stop="commitRename(($event.target as HTMLInputElement).value)"
        @keydown.esc.stop="$emit('cancel-edit')"
        @blur="commitRename(($event.target as HTMLInputElement).value)"
      />
      <div v-else class="fm-grid-name" :title="`${entry.name}${metaSuffix(entry)}`">{{ entry.name }}</div>
      <div class="fm-grid-meta">{{ metaText(entry) }}</div>
    </div>
    <div v-if="creating" class="fm-grid-cell is-creating">
      <el-icon class="fm-grid-icon">
        <Document v-if="creating.kind === 'file'" />
        <FolderAdd v-else />
      </el-icon>
      <input
        ref="createInput"
        class="fm-grid-rename"
        placeholder="名称"
        @click.stop
        @input="createDone = false"
        @keydown.enter.stop="commitCreate(($event.target as HTMLInputElement).value)"
        @keydown.esc.stop="$emit('cancel-edit')"
        @blur="commitCreate(($event.target as HTMLInputElement).value)"
      />
      <div class="fm-grid-meta">新建{{ creating.kind === 'dir' ? '文件夹' : '文件' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Check, Document, FolderAdd, FolderOpened, Link, Picture } from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'
import { DRAG_PATHS_MIME, effectiveDragSources, formatSize, formatTime, iconKindOf } from '../../utils/file-manager'

const props = defineProps<{
  entries: FileNode[]
  selectedPaths: string[]
  renamingPath: string
  creating: { dir: string; kind: 'file' | 'dir' } | null
  dropTargetPath: string
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

function metaText(entry: FileNode): string {
  if (entry.isDirectory) return formatTime(entry.mtime)
  return `${formatSize(entry.size)} · ${formatTime(entry.mtime)}`
}

function metaSuffix(entry: FileNode): string {
  return `\n${metaText(entry)}`
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
.fm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
  padding: 12px;
  align-content: start;
}

.fm-grid-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--aw-radius-sm, 8px);
  cursor: default;
  user-select: none;
}

.fm-grid-cell:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
}

.fm-grid-cell.selected {
  border-color: var(--aw-primary, #0066cc);
  background: color-mix(in srgb, var(--aw-primary, #0066cc) 8%, transparent);
}

.fm-grid-cell.is-drop-target {
  border-color: var(--aw-primary, #0066cc);
  border-style: dashed;
  background: color-mix(in srgb, var(--aw-primary, #0066cc) 14%, transparent);
}

.fm-grid-cell.is-symlink .fm-grid-icon {
  opacity: 0.75;
}

.fm-grid-check {
  position: absolute;
  top: 4px;
  left: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aw-primary, #0066cc);
  color: #fff;
  font-size: 11px;
}

.fm-grid-icon {
  font-size: 34px;
  color: var(--aw-ink-muted, #666);
}

.fm-grid-icon.is-folder {
  color: var(--aw-primary, #0066cc);
}

.fm-grid-icon.is-image {
  color: #7c5cbf;
}

.fm-grid-name {
  max-width: 100%;
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-grid-meta {
  max-width: 100%;
  font-size: var(--aw-text-fine, 11px);
  color: var(--aw-ink-muted-48, #999);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-grid-rename {
  width: 100%;
  padding: 2px 4px;
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-primary, #0066cc);
  border-radius: var(--aw-radius-xs, 4px);
  text-align: center;
}

[data-theme="dark"] .fm-grid-cell:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .fm-grid-name {
  color: var(--aw-ink, #e0e0e0);
}

/* 移动端（窄视口 / 安卓 Capacitor 壳）：桌面密度的 110px 格子 + 34px 图标在手机上
   既占屏又空，改成 3 列紧凑网格：小图标、小字号、单元格贴边省左右留白，
   图标与文字的间距也一并收紧。 */
@media (max-width: 768px) {
  .fm-grid {
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 4px;
    padding: 8px;
  }

  .fm-grid-cell {
    gap: 4px;
    padding: 8px 4px 6px;
    border-radius: var(--aw-radius-xs, 4px);
  }

  .fm-grid-icon {
    font-size: 22px;
  }

  .fm-grid-check {
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    font-size: 9px;
  }

  .fm-grid-name {
    font-size: var(--aw-text-fine, 11px);
  }

  .fm-grid-meta {
    font-size: var(--aw-text-micro, 10px);
  }
}
</style>
