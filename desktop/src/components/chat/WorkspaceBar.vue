<template>
  <div class="workspace-bar">
    <el-icon class="workspace-icon"><FolderOpened /></el-icon>
    <span class="workspace-label">工作目录</span>
    <span class="workspace-path" :class="{ empty: !workspace }">
      {{ workspace || '未选择目录' }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'

defineProps<{ workspace: string }>()
</script>

<style scoped>
.workspace-bar {
  display: flex;
  align-items: center;
  gap: var(--aw-space-xs);
  padding: 8px 12px;
  background: var(--aw-canvas-parchment);
  border-bottom: 1px solid var(--aw-divider-soft);
  font-size: var(--aw-text-caption);
  flex-shrink: 0;
  margin: 0 -24px;
  padding: 8px 24px;
}

.workspace-icon {
  color: var(--aw-primary);
  flex-shrink: 0;
}

.workspace-label {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
  letter-spacing: -0.224px;
}

.workspace-path {
  color: var(--aw-ink);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.workspace-path.empty {
  color: var(--aw-ink-muted-48);
  font-style: italic;
  font-family: var(--aw-font-text);
}
</style>
