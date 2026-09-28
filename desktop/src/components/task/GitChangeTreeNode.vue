<template>
  <div class="git-tree-node">
    <div
      class="git-node-row"
      :class="{ 'is-dir': node.kind === 'dir' }"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      :title="rowTitle"
      @click="handleClick"
      @contextmenu.prevent="handleContextMenu"
    >
      <el-icon v-if="node.kind === 'dir'" class="git-expand">
        <ArrowDown v-if="expanded" />
        <ArrowRight v-else />
      </el-icon>
      <span v-else class="git-expand-placeholder" />

      <el-icon class="git-icon">
        <FolderOpened v-if="node.kind === 'dir' && expanded" />
        <Folder v-else-if="node.kind === 'dir'" />
        <Document v-else />
      </el-icon>

      <span v-if="node.kind === 'file'" class="git-type" :class="typeClass(node.file.changeType)">
        {{ typeLabel(node.file.changeType) }}
      </span>

      <span class="git-node-name">{{ node.name }}</span>
      <span v-if="node.kind === 'file' && node.file.oldPath" class="git-file-old">
        {{ node.file.oldPath }}
      </span>

      <span v-if="node.kind === 'file'" class="git-lines">
        <template v-if="node.file.binary">binary</template>
        <template v-else>
          <span class="add">+{{ node.file.insertions }}</span>
          <span class="del">-{{ node.file.deletions }}</span>
        </template>
      </span>
    </div>

    <template v-if="node.kind === 'dir' && expanded">
      <GitChangeTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :collapsed="collapsed"
        @toggle="$emit('toggle', $event)"
        @open-diff="$emit('open-diff', $event)"
        @contextmenu="$emit('contextmenu', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight, ArrowDown, Folder, FolderOpened, Document } from '@element-plus/icons-vue'
import type { GitChangedFile, GitTreeNode } from '../../types/git'

const props = defineProps<{
  node: GitTreeNode
  depth: number
  collapsed: Set<string>
}>()

const emit = defineEmits<{
  toggle: [path: string]
  'open-diff': [file: GitChangedFile]
  'contextmenu': [payload: { node: GitTreeNode; x: number; y: number }]
}>()

const expanded = computed(() => {
  if (props.node.kind !== 'dir') return false
  return !props.collapsed.has(props.node.path)
})

const rowTitle = computed(() => {
  if (props.node.kind === 'file') return props.node.path
  return props.node.path || props.node.name
})

function handleClick() {
  if (props.node.kind === 'dir') {
    emit('toggle', props.node.path)
    return
  }
  emit('open-diff', props.node.file)
}

function handleContextMenu(event: MouseEvent) {
  emit('contextmenu', {
    node: props.node,
    x: event.clientX,
    y: event.clientY,
  })
}

function typeLabel(type: string) {
  switch (type) {
    case 'CREATED': return 'A'
    case 'DELETED': return 'D'
    case 'RENAMED': return 'R'
    case 'COPIED': return 'C'
    default: return 'M'
  }
}

function typeClass(type: string) {
  switch (type) {
    case 'CREATED': return 'created'
    case 'DELETED': return 'deleted'
    case 'RENAMED': return 'renamed'
    case 'COPIED': return 'copied'
    default: return 'modified'
  }
}
</script>

<style scoped>
.git-node-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-top: 5px;
  padding-bottom: 5px;
  padding-right: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.git-node-row:hover {
  background: var(--aw-primary-hover);
}

.git-expand,
.git-expand-placeholder {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.git-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.git-node-row.is-dir .git-icon {
  color: var(--aw-primary);
}

.git-type {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  font-family: var(--aw-font-mono);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.git-type.created { color: var(--aw-diff-add); background: var(--aw-diff-add-bg); }
.git-type.modified { color: var(--aw-diff-mod); background: var(--aw-diff-mod-bg); }
.git-type.deleted { color: var(--aw-diff-del); background: var(--aw-diff-del-bg); }
.git-type.renamed,
.git-type.copied { color: var(--aw-diff-info); background: var(--aw-diff-info-bg); }

.git-node-name {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  line-height: 18px;
  white-space: nowrap;
}

.git-file-old {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: 11px;
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
  white-space: nowrap;
  margin-left: 4px;
}

.git-lines {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: 11px;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-left: 8px;
  white-space: nowrap;
}

.add { color: var(--aw-diff-add); }
.del { color: var(--aw-diff-del); }

[data-theme="dark"] .git-node-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
