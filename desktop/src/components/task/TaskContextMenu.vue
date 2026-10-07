<template>
  <Teleport to="body">
    <div
      v-if="contextMenu.visible"
      class="task-context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <template v-if="contextMenu.zone === 'archived'">
        <div class="context-menu-item" @click="menuShare">分享…</div>
        <div class="context-menu-item" @click="menuExportMarkdown">导出 Markdown</div>
        <div class="context-menu-item" @click="menuUnarchive">恢复</div>
        <div class="context-menu-item" @click="menuEditTitle">编辑标题</div>
        <div class="context-menu-item danger" @click="menuDelete">删除</div>
      </template>
      <template v-else>
        <div class="context-menu-item" @click="menuShare">分享…</div>
        <div class="context-menu-item" @click="menuExportMarkdown">导出 Markdown</div>
        <div class="context-menu-item" @click="menuEditTitle">编辑标题</div>
        <div class="context-menu-item" @click="menuArchive">归档</div>
        <div class="context-menu-item danger" @click="menuDelete">删除</div>
      </template>
    </div>

    <!-- 分组头右键菜单（仅可改名分组显示重命名，存在别名时显示重置） -->
    <div
      v-if="groupContextMenu.visible"
      class="task-context-menu"
      :style="{ left: groupContextMenu.x + 'px', top: groupContextMenu.y + 'px' }"
      @click.stop
    >
      <div v-if="isGroupRenameable(groupContextMenu.key)" class="context-menu-item" @click="menuRenameGroup">重命名</div>
      <div v-if="hasGroupAlias(groupContextMenu.key)" class="context-menu-item" @click="menuResetGroup">重置名称</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { isGroupRenameable } from '../../utils/cloud-project'

defineProps<{
  contextMenu: {
    visible: boolean
    x: number
    y: number
    sessionId: string | null
    zone: 'standard' | 'archived'
  }
  groupContextMenu: {
    visible: boolean
    x: number
    y: number
    key: string
  }
  menuArchive: () => void
  menuUnarchive: () => void
  menuEditTitle: () => void
  menuDelete: () => void
  menuShare: () => void
  menuExportMarkdown: () => void
  menuRenameGroup: () => void
  menuResetGroup: () => void
  hasGroupAlias: (key: string) => boolean
}>()
</script>

<style>
/* 右键菜单（Teleport 到 body，scoped 外） */
.task-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  padding: 4px 0;
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-divider-soft, #e0e0e0);
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  user-select: none;
}

.context-menu-item {
  padding: 7px 16px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.context-menu-item:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-primary, #0066cc);
}

.context-menu-item.danger {
  color: var(--aw-danger, #d92d20);
}

.context-menu-item.danger:hover {
  background: #fee2e2;
}

[data-theme="dark"] .task-context-menu {
  background: #2a2a2a;
  border-color: var(--aw-hairline, #3a3a3a);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .context-menu-item {
  color: var(--aw-ink, #e0e0e0);
}

[data-theme="dark"] .context-menu-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--aw-primary);
}

[data-theme="dark"] .context-menu-item.danger:hover {
  background: #3b1520;
  color: #f85149;
}
</style>
