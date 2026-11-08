<template>
  <div
    ref="barEl"
    class="center-tab-bar"
    :class="{ 'is-drag-over': barDragOver }"
    @dragover="onBarDragOver"
    @dragleave="onBarDragLeave"
    @drop.prevent="onBarDrop"
  >
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab-item"
      :class="{ active: tab.id === activeTabId }"
      @click="$emit('activate', tab.id)"
      @contextmenu.prevent="onContextMenu($event, tab)"
    >
      <AgentAvatar
        v-if="tab.type === 'chat' && agentIdentity.id"
        :name="agentIdentity.name"
        :avatar-url="agentIdentity.avatarUrl"
        :size="18"
        class="tab-icon tab-agent-avatar"
      />
      <el-icon v-else-if="tab.type === 'chat' || tab.type === 'side_task' || tab.type === 'subagent'" class="tab-icon"><ChatDotRound /></el-icon>
      <el-icon v-else-if="tab.type === 'diff'" class="tab-icon"><DocumentCopy /></el-icon>
      <el-icon v-else-if="tab.type === 'trace'" class="tab-icon"><TrendCharts /></el-icon>
      <el-icon v-else-if="tab.type === 'git'" class="tab-icon"><Share /></el-icon>
      <el-icon v-else-if="tab.type === 'workspace_overview'" class="tab-icon"><FolderOpened /></el-icon>
      <el-icon v-else class="tab-icon"><Document /></el-icon>
      <el-tooltip v-if="tab.filePath" :content="tab.filePath" placement="bottom" :show-after="300">
        <span class="tab-title">{{ tab.title }}</span>
      </el-tooltip>
      <el-tooltip v-else-if="tab.forkFrom?.label" :content="`分叉自主会话 · ${tab.forkFrom.label}`" placement="bottom" :show-after="300">
        <span class="tab-title">{{ tab.title }}</span>
      </el-tooltip>
      <span v-else class="tab-title">{{ tab.title }}</span>
      <button
        v-if="tab.type !== 'chat'"
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
        ref="menuRef"
        class="tab-context-menu"
        :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
        @click="contextMenu.visible = false"
      >
        <div class="context-menu-item" @click="$emit('close', contextMenu.tabId!)">
          关闭当前
        </div>
        <div class="context-menu-item" @click="$emit('close-all')">
          关闭所有文件
        </div>
        <div class="context-menu-item" @click="$emit('close-others', contextMenu.tabId!)">
          关闭其他文件
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ChatDotRound, Document, DocumentCopy, Close, Share, TrendCharts, FolderOpened } from '@element-plus/icons-vue'
import type { Tab } from '../../types/file-browser'
import { shouldDismissContextMenuForScroll } from '../../utils/contextMenuDismiss'
import { fileEntriesOf, hasWorkspaceDragPayload, parseWorkspaceDrag, type WorkspaceDragEntry } from '../../utils/workspaceDrag'
import { useAgentStore } from '../../stores/agent'
import { resolveAgentIdentity } from '../../utils/agent-identity'
import AgentAvatar from '../agent/AgentAvatar.vue'

const props = defineProps<{
  tabs: Tab[]
  activeTabId: string
  /** 主会话 Tab 的 Agent 头像：有归属 Agent 时替代默认会话图标 */
  agentId?: string | null
  agentName?: string | null
}>()

const agentStore = useAgentStore()

const agentIdentity = computed(() =>
  resolveAgentIdentity({
    agentId: props.agentId,
    fallbackName: props.agentName,
    activeAgent: agentStore.activeAgent,
    agents: agentStore.agents,
  }),
)

const emit = defineEmits<{
  activate: [tabId: string]
  close: [tabId: string]
  'close-all': []
  'close-others': [tabId: string]
  'workspace-file-drop': [entries: WorkspaceDragEntry[]]
}>()

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  tabId: null as string | null,
})

const barEl = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLDivElement>()
const adjustedX = ref(0)
const adjustedY = ref(0)

// ===== 工作区文件拖入落点（目录已被 fileEntriesOf 过滤；entries 携带源工作区根，宿主据此路由）=====

const barDragOver = ref(false)

function droppableEntries(e: DragEvent): WorkspaceDragEntry[] {
  return fileEntriesOf(parseWorkspaceDrag(e.dataTransfer))
}

function onBarDragOver(e: DragEvent) {
  // dragover 处于 protected mode 读不到载荷数据，只能查 types；非 mao 载荷不成为落点（保持默认禁止光标）
  if (!hasWorkspaceDragPayload(e.dataTransfer)) {
    barDragOver.value = false
    return
  }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  barDragOver.value = true
}

function onBarDragLeave(e: DragEvent) {
  // tab-item 覆盖整栏，进出子元素时 dragleave 也会冒泡触发，仅在真正离开栏时才取消高亮
  const next = e.relatedTarget as Node | null
  if (!next || !barEl.value?.contains(next)) barDragOver.value = false
}

function onBarDrop(e: DragEvent) {
  barDragOver.value = false
  const entries = droppableEntries(e)
  if (entries.length > 0) emit('workspace-file-drop', entries)
}

/** 拖拽在别处松手 / Esc 取消时栏上不再收到任何事件，全局 dragend 兜底清高亮（防 is-drag-over 卡死） */
function onWindowDragEnd() {
  barDragOver.value = false
}

function onContextMenu(e: MouseEvent, tab: Tab) {
  if (tab.type === 'chat') return
  contextMenu.x = e.clientX
  contextMenu.y = e.clientY
  contextMenu.tabId = tab.id
  contextMenu.visible = true
}

watch(() => [contextMenu.visible, contextMenu.x, contextMenu.y] as const, async ([vis, px, py]) => {
  if (!vis) return
  adjustedX.value = px
  adjustedY.value = py
  await nextTick()
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 4
  let nx = px
  let ny = py
  if (px + rect.width > window.innerWidth - margin) {
    nx = Math.max(margin, window.innerWidth - rect.width - margin)
  }
  if (py + rect.height > window.innerHeight - margin) {
    ny = Math.max(margin, window.innerHeight - rect.height - margin)
  }
  adjustedX.value = nx
  adjustedY.value = ny
})

function hideContextMenu() {
  contextMenu.visible = false
}

/** Tab 栏自身滚动时关闭。对话区随 Agent 执行贴底滚动不关。 */
function onWindowScroll(e: Event) {
  if (!shouldDismissContextMenuForScroll(e.target, barEl.value)) return
  hideContextMenu()
}

onMounted(() => {
  document.addEventListener('click', hideContextMenu)
  window.addEventListener('scroll', onWindowScroll, true)
  document.addEventListener('dragend', onWindowDragEnd)
})
onUnmounted(() => {
  document.removeEventListener('click', hideContextMenu)
  window.removeEventListener('scroll', onWindowScroll, true)
  document.removeEventListener('dragend', onWindowDragEnd)
})
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

.center-tab-bar.is-drag-over {
  outline: 2px dashed var(--aw-primary, #409eff);
  outline-offset: -2px;
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

/* Mobile / touch: no reliable hover — keep close button visible */
@media (max-width: 768px), (hover: none) {
  .tab-close {
    opacity: 1;
  }
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
