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
      <span
        v-if="node.kind === 'file' && node.file.changeType === 'DELETED' && deletedTag"
        class="git-file-tag"
      >{{ deletedTag }}</span>
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
      <button
        v-if="showDiscard && node.kind === 'file'"
        class="git-discard-btn"
        :disabled="!!discardDisabledReason"
        :aria-label="`撤销 ${node.name} 的改动`"
        :title="discardDisabledReason || `撤销 ${node.name} 的改动`"
        @click.stop="$emit('discard', node)"
      >
        <el-icon :size="13"><RefreshLeft /></el-icon>
      </button>
    </div>

    <template v-if="node.kind === 'dir' && expanded">
      <GitChangeTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :collapsed="collapsed"
        :deleted-tag="deletedTag"
        :show-discard="showDiscard"
        :discard-disabled-reason="discardDisabledReason"
        @toggle="$emit('toggle', $event)"
        @open-diff="$emit('open-diff', $event)"
        @contextmenu="$emit('contextmenu', $event)"
        @discard="$emit('discard', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight, ArrowDown, Folder, FolderOpened, Document, RefreshLeft } from '@element-plus/icons-vue'
import type { GitChangedFile, GitTreeNode } from '../../types/git'

const props = defineProps<{
  node: GitTreeNode
  depth: number
  collapsed: Set<string>
  /**
   * 仅基准分支存在的文件（`changeType === 'DELETED'`）的附加标记文案。
   * 两点分支对比视图传「仅基准分支」；其它视图（变更 / 提交 diff）不传，行为不变。
   */
  deletedTag?: string
  /** 中央 Git 管理器「变更」视图：文件行末尾显示撤销按钮；对比 / 侧边栏视图不传 */
  showDiscard?: boolean
  /** 撤销按钮禁用原因（非空即禁用，并写在 title 上） */
  discardDisabledReason?: string
}>()

const emit = defineEmits<{
  toggle: [path: string]
  'open-diff': [file: GitChangedFile]
  'contextmenu': [payload: { node: GitTreeNode; x: number; y: number }]
  discard: [node: GitTreeNode]
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
  font-size: var(--git-fs-row, 13px);
  color: var(--aw-ink);
  line-height: 18px;
  white-space: nowrap;
}

.git-file-tag {
  flex-shrink: 0;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
  color: var(--aw-ink-muted-48);
  background: var(--aw-surface-pearl);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
  white-space: nowrap;
}

.git-file-old {
  flex-shrink: 0;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
  white-space: nowrap;
  margin-left: 4px;
}

.git-lines {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--git-fs-code, 11px);
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-left: 8px;
  white-space: nowrap;
}

.add { color: var(--aw-diff-add); }
.del { color: var(--aw-diff-del); }

.git-discard-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 6px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
}

.git-node-row:hover .git-discard-btn,
.git-discard-btn:focus-visible {
  opacity: 1;
}

.git-discard-btn:hover:not(:disabled) {
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 10%, transparent);
}

.git-discard-btn:disabled {
  cursor: default;
}

.git-node-row:hover .git-discard-btn:disabled {
  opacity: 0.38;
}

@media (hover: none) {
  .git-discard-btn { opacity: 1; }
  .git-discard-btn:disabled { opacity: 0.38; }
}

[data-theme="dark"] .git-node-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
