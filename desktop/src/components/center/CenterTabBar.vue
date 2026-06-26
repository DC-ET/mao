<template>
  <div class="center-tab-bar">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab-item"
      :class="{ active: tab.id === activeTabId }"
      @click="$emit('activate', tab.id)"
      @contextmenu.prevent="onContextMenu($event, tab)"
    >
      <el-icon v-if="tab.type === 'chat'" class="tab-icon"><ChatDotRound /></el-icon>
      <el-icon v-else class="tab-icon"><Document /></el-icon>
      <el-tooltip v-if="tab.filePath" :content="tab.filePath" placement="bottom" :show-after="300">
        <span class="tab-title">{{ tab.title }}</span>
      </el-tooltip>
      <span v-else class="tab-title">{{ tab.title }}</span>
      <button
        v-if="tab.type === 'file'"
        class="tab-close"
        @click.stop="$emit('close', tab.id)"
      >
        <el-icon :size="12"><Close /></el-icon>
      </button>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="tab-context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click="contextMenu.visible = false"
      >
        <div class="context-menu-item" @click="$emit('close', contextMenu.tabId!)">
          关闭当前 Tab
        </div>
        <div class="context-menu-item" @click="$emit('close-all')">
          关闭所有文件 Tab
        </div>
        <div class="context-menu-item" @click="$emit('close-others', contextMenu.tabId!)">
          关闭其他文件 Tab
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { reactive, onMounted, onUnmounted } from 'vue'
import { ChatDotRound, Document, Close } from '@element-plus/icons-vue'
import type { Tab } from '../../types/file-browser'

defineProps<{
  tabs: Tab[]
  activeTabId: string
}>()

defineEmits<{
  activate: [tabId: string]
  close: [tabId: string]
  'close-all': []
  'close-others': [tabId: string]
}>()

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  tabId: null as string | null,
})

function onContextMenu(e: MouseEvent, tab: Tab) {
  if (tab.type === 'chat') return
  contextMenu.x = e.clientX
  contextMenu.y = e.clientY
  contextMenu.tabId = tab.id
  contextMenu.visible = true
}

function hideContextMenu() {
  contextMenu.visible = false
}

onMounted(() => document.addEventListener('click', hideContextMenu))
onUnmounted(() => document.removeEventListener('click', hideContextMenu))
</script>

<style scoped>
.center-tab-bar {
  display: flex;
  align-items: stretch;
  height: 36px;
  min-height: 36px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas);
  overflow-x: auto;
  scrollbar-width: none;
}

.center-tab-bar::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 14px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  white-space: nowrap;
  border-right: 1px solid var(--aw-divider-soft);
  transition: color 0.15s, background 0.15s;
  user-select: none;
  position: relative;
}

.tab-item:hover {
  color: var(--aw-ink);
  background: var(--aw-canvas-parchment);
}

.tab-item.active {
  color: var(--aw-ink);
  background: var(--aw-surface);
}

.tab-item.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--aw-primary);
}

.tab-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.tab-title {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.tab-item:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--aw-ink);
}

/* Dark mode */
[data-theme="dark"] .center-tab-bar {
  background: var(--aw-canvas);
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .tab-item {
  border-right-color: var(--aw-hairline);
}

[data-theme="dark"] .tab-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .tab-close:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>

<style>
/* Context menu (Teleported outside scoped boundary) */
.tab-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  padding: 4px 0;
  background: #fff;
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-divider-soft, #e0e0e0);
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.context-menu-item {
  padding: 6px 16px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
}

.context-menu-item:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-primary, #0066cc);
}

[data-theme="dark"] .tab-context-menu {
  background: #2a2a2a;
  border-color: var(--aw-hairline, #3a3a3a);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .context-menu-item {
  color: var(--aw-ink, #e0e0e0);
}

[data-theme="dark"] .context-menu-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
